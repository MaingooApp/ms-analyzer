import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

import { envs } from 'src/config';
import type { ExtractionResult, ExtractedLineItem } from './interfaces';
import { isValidSpanishNif } from 'src/common/utils';

interface ExtractParams {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  notes?: string;
}

interface RawProveedor {
  nombre?: unknown;
  nif?: unknown;
  direccion?: unknown;
  telefono?: unknown;
  email?: unknown;
}

interface RawFactura {
  numero?: unknown;
  fecha_emision?: unknown;
  fecha_vencimiento?: unknown;
  forma_pago?: unknown;
  total_con_iva?: unknown;
  total_sin_iva?: unknown;
  impuestos?: unknown;
  moneda?: unknown;
}

interface RawProducto {
  numero_albaran?: unknown;
  referencia?: unknown;
  descripcion?: unknown;
  cantidad?: unknown;
  precio?: unknown;
  total?: unknown;
}

interface RawExtraction {
  proveedor?: RawProveedor | null;
  factura?: RawFactura | null;
  productos?: RawProducto[] | null;
}

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);
  private readonly client = new OpenAI({
    apiKey: envs.openAiApiKey,
    timeout: envs.openAiTimeoutMs,
  });

  async extractInvoice(params: ExtractParams): Promise<ExtractionResult> {
    const prompt = this.buildPrompt(params.notes);
    const schema = this.buildSchema();
    const encodedImage = params.buffer.toString('base64');

    for (let attempt = 0; attempt <= envs.openAiMaxRetries; attempt++) {
      try {
        const response = await this.client.responses.create({
          model: envs.openAiModel,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: prompt },
                {
                  type: 'input_image',
                  image_url: `data:${params.mimetype};base64,${encodedImage}`,
                  detail: 'auto',
                },
              ],
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'invoice_extraction',
              schema,
              strict: true,
            },
          },
          max_output_tokens: 1200,
        });

        const parsed = this.parseResponse(response);
        return this.normalizeResult(parsed);
      } catch (error) {
        const message = (error as Error).message;
        this.logger.warn(`OpenAI attempt ${attempt + 1} failed: ${message}`);
        if (attempt === envs.openAiMaxRetries) {
          throw error;
        }
        await this.delay(300 * (attempt + 1));
      }
    }

    throw new Error('OpenAI extraction failed');
  }

  private parseResponse(response: any): RawExtraction {
    const output = response.output?.[0]?.content ?? [];

    for (const item of output) {
      if (item.type === 'output_json' && item.json) {
        return item.json as RawExtraction;
      }

      if ('text' in item && item.text) {
        try {
          return JSON.parse(item.text) as RawExtraction;
        } catch (error) {
          this.logger.debug('Failed to parse OpenAI text response', error as Error);
        }
      }
    }

    throw new Error('OpenAI returned an unexpected response');
  }

  private normalizeResult(raw: RawExtraction): ExtractionResult {
    const normalizeText = (value: unknown): string | null => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }

      if (typeof value === 'number') {
        return value.toString();
      }

      return null;
    };

    const normalizeNumber = (value: unknown): number | null => {
      if (value === null || value === undefined) {
        return null;
      }

      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
      }

      if (typeof value === 'string') {
        const cleaned = value.replace(/[^0-9.,-]/g, '').replace(',', '.');
        const parsed = Number.parseFloat(cleaned);
        return Number.isFinite(parsed) ? parsed : null;
      }

      return null;
    };

    const normalizeDate = (value: unknown): string | null => {
      if (!value) {
        return null;
      }

      const parsed = new Date(value as string);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    };

    const proveedor = raw?.proveedor ?? {};
    const factura = raw?.factura ?? {};
    const productos = Array.isArray(raw?.productos) ? (raw.productos as RawProducto[]) : [];

    const supplierName = normalizeText(proveedor.nombre);
    const rawTaxId = normalizeText(proveedor.nif)?.toUpperCase() ?? null;
    const supplierTaxId = rawTaxId && isValidSpanishNif(rawTaxId) ? rawTaxId : null;

    const totalWithoutTax = normalizeNumber(factura.total_sin_iva);
    const totalWithTax = normalizeNumber(factura.total_con_iva);
    const taxesFromField = normalizeNumber(factura.impuestos);
    const taxes =
      taxesFromField ??
      (totalWithTax !== null && totalWithoutTax !== null ? totalWithTax - totalWithoutTax : null);

    const lines: ExtractedLineItem[] = productos
      .map((producto) => {
        const quantity = normalizeNumber(producto.cantidad);
        const unitPrice = normalizeNumber(producto.precio);
        const total = normalizeNumber(producto.total);
        const computedTotal =
          total ??
          (quantity !== null && unitPrice !== null
            ? Number((quantity * unitPrice).toFixed(2))
            : null);

        return {
          description: normalizeText(producto.descripcion),
          productCode: normalizeText(producto.referencia),
          quantity,
          unitPrice,
          total: computedTotal,
        };
      })
      .filter(
        (line) =>
          line.description !== null ||
          line.productCode !== null ||
          line.quantity !== null ||
          line.unitPrice !== null ||
          line.total !== null,
      );

    const currency = normalizeText(factura.moneda)?.toUpperCase() ?? 'EUR';

    return {
      supplierName,
      supplierTaxId,
      invoiceNumber: normalizeText(factura.numero),
      issueDate: normalizeDate(factura.fecha_emision),
      total: totalWithTax,
      taxes,
      currency,
      lines,
    };
  }

  private buildPrompt(notes?: string) {
    const basePrompt = `Eres un experto en OCR y extracción de datos de facturas comerciales. Analiza cuidadosamente esta imagen de factura o albarán y extrae TODOS los datos estructurados.

IMPORTANTE: Devuelve ÚNICAMENTE un objeto JSON válido, sin texto adicional antes o después.

FORMATO DE RESPUESTA:
{
  "proveedor": {
    "nombre": "Nombre completo de la empresa proveedora",
    "nif": "NIF/CIF/VAT del proveedor (puede tener formatos: A12345678, B-12/345678, 12345678A, ESA12345678, etc.)",
    "direccion": "Dirección completa del proveedor",
    "telefono": "Número de teléfono",
    "email": "Email si está disponible"
  },
  "factura": {
    "numero": "Número de factura/albarán (ej: 008/527 9254, FAC-2024-001, etc.)",
    "fecha_emision": "Fecha de emisión en formato ISO (YYYY-MM-DD o YYYY-MM-DDThh:mm:ssZ)",
    "fecha_vencimiento": "Fecha de vencimiento si existe",
    "forma_pago": "Método de pago (transferencia, contado, etc.)",
    "total_sin_iva": "Subtotal antes de impuestos (solo número con decimales)",
    "impuestos": "Total de impuestos/IVA (solo número con decimales)",
    "total_con_iva": "Total final con impuestos incluidos (solo número con decimales)",
    "moneda": "Código de moneda (EUR, USD, GBP, etc.)"
  },
  "productos": [
    {
      "numero_albaran": "Número de albarán si existe",
      "referencia": "Código/referencia del producto",
      "descripcion": "Descripción COMPLETA del producto tal como aparece",
      "cantidad": "Cantidad numérica (usa punto decimal, ej: 2.85)",
      "precio": "Precio unitario (usa punto decimal, ej: 3.62)",
      "total": "Total de la línea (cantidad × precio, usa punto decimal)"
    }
  ]
}`;

    const guidelines = `REGLAS CRÍTICAS DE EXTRACCIÓN:

📋 DATOS DEL PROVEEDOR:
- Busca el nombre del proveedor en la parte superior del documento
- NIF/CIF: Busca términos como "NIF:", "CIF:", "N.I.F.:", "C.I.F.:", "VAT:", "Tax ID:", "Registro Mercantil"
- Formatos válidos de NIF: A12345678, B-12/345678, A-28/647451, ESA12345678, 12345678A
- Si NO encuentras el NIF después de revisar todo el documento, usa null
- Dirección: Busca dirección completa con calle, número, código postal y ciudad
- Teléfono/Email: Pueden estar cerca del logotipo o pie de página

💰 DATOS DE LA FACTURA:
- Número: Puede aparecer como "Factura nº", "Invoice", "Doc.", "Albarán", etc.
- Fechas: Convierte al formato ISO 8601 (YYYY-MM-DD o YYYY-MM-DDThh:mm:ssZ)
- Importes: 
  * Extrae SOLO números con punto decimal (ej: 459.58)
  * NO incluyas símbolos de moneda (€, $, £)
  * Busca "Base imponible", "Subtotal", "Total sin IVA" para total_sin_iva
  * Busca "IVA", "VAT", "Tax", "Impuestos" para impuestos
  * Busca "Total", "Total a pagar", "Importe total" para total_con_iva
- Moneda: Usa EUR por defecto para España, busca símbolos €, USD ($), GBP (£)

📦 LÍNEAS DE PRODUCTOS:
- Extrae TODAS las líneas de productos/servicios de la factura
- Descripción: Copia el texto EXACTO tal como aparece, incluyendo:
  * Nombre del producto
  * Marca si aparece
  * Presentación/formato (kg, unidades, litros, etc.)
  * NO inventes ni resumas, copia literalmente
- Cantidad: Busca columnas "Cant.", "Cantidad", "Qty", "Uds"
  * Usa punto como separador decimal (2.85, no 2,85)
  * Si aparece "28,5 kg", extrae 28.5
- Precio unitario: Busca "Precio", "P.Unit", "Price", "€/ud"
  * Extrae solo el número (3.62, no €3,62)
- Total línea: Busca "Importe", "Total", o calcula cantidad × precio
  * SIEMPRE debe estar presente
  * Si no aparece explícitamente, CALCÚLALO: cantidad × precio_unitario

🔍 ESTRATEGIA DE BÚSQUEDA:
1. Identifica primero la estructura del documento (dónde está el proveedor, cliente, tabla de productos)
2. Busca palabras clave en VARIOS idiomas (español, inglés, catalán)
3. Ten en cuenta que los campos pueden tener etiquetas diferentes:
   - "Proveedor", "Supplier", "Vendor", "De:", "From:"
   - "Cliente", "Customer", "Para:", "To:", "Bill to:"
   - "Cantidad", "Cant.", "Qty", "Units", "Uds"
4. Lee la tabla de productos línea por línea, de arriba a abajo
5. Ignora líneas de subtotales, IVA desglosado o notas al pie

⚠️ VALIDACIONES:
- Si un campo no existe en el documento, usa null (no inventes datos)
- Los números SIEMPRE con punto decimal, nunca coma
- Las fechas SIEMPRE en formato ISO 8601
- El JSON debe ser válido y parseable
- NO incluyas comentarios en el JSON
- NO incluyas texto explicativo fuera del JSON`;

    return [basePrompt, guidelines, notes ? `\n\n📝 CONTEXTO ADICIONAL:\n${notes}` : undefined]
      .filter(Boolean)
      .join('\n\n');
  }

  private buildSchema() {
    return {
      type: 'object',
      properties: {
        proveedor: {
          type: 'object',
          properties: {
            nombre: { type: ['string', 'null'] },
            nif: { type: ['string', 'null'] },
            direccion: { type: ['string', 'null'] },
            telefono: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
          },
          required: ['nombre', 'nif', 'direccion', 'telefono', 'email'],
          additionalProperties: false,
        },
        factura: {
          type: 'object',
          properties: {
            numero: { type: ['string', 'null'] },
            fecha_emision: { type: ['string', 'null'] },
            fecha_vencimiento: { type: ['string', 'null'] },
            forma_pago: { type: ['string', 'null'] },
            total_sin_iva: { type: ['number', 'string', 'null'] },
            impuestos: { type: ['number', 'string', 'null'] },
            total_con_iva: { type: ['number', 'string', 'null'] },
            moneda: { type: ['string', 'null'] },
          },
          required: [
            'numero',
            'fecha_emision',
            'fecha_vencimiento',
            'forma_pago',
            'total_sin_iva',
            'impuestos',
            'total_con_iva',
            'moneda',
          ],
          additionalProperties: false,
        },
        productos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              numero_albaran: { type: ['string', 'null'] },
              referencia: { type: ['string', 'null'] },
              descripcion: { type: ['string', 'null'] },
              cantidad: { type: ['number', 'string', 'null'] },
              precio: { type: ['number', 'string', 'null'] },
              total: { type: ['number', 'string', 'null'] },
            },
            required: [
              'numero_albaran',
              'referencia',
              'descripcion',
              'cantidad',
              'precio',
              'total',
            ],
            additionalProperties: false,
          },
          default: [],
        },
      },
      required: ['proveedor', 'factura', 'productos'],
      additionalProperties: false,
    };
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
