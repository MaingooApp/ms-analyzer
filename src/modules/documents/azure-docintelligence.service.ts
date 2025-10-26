import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import createClient, {
  getLongRunningPoller,
  isUnexpected,
  type AnalyzeOperationOutput,
  type DocumentFieldOutput, // <- v4: los campos son DocumentFieldOutput
} from '@azure-rest/ai-document-intelligence';
import { AzureKeyCredential } from '@azure/core-auth';
import { normalizeSpanishTaxId } from 'src/common/utils/taxid';
import { isValidSpanishNif } from 'src/common/utils';
import { envs } from 'src/config';

export type AzureInvoiceExtraction = {
  // --- Proveedor ---
  supplierName: string | null;
  supplierTaxId: string | null;
  supplierAddress: string | null;
  supplierRecipient: string | null;

  // --- Cliente ---
  customerName: string | null;
  customerTaxId: string | null;
  customerAddress: string | null;
  customerRecipient: string | null;
  customerId: string | null;

  // --- Factura ---
  invoiceNumber: string | null;
  issueDate: string | null; // ISO
  dueDate: string | null; // ISO
  subtotal: number | null;
  total: number | null;
  taxes: number | null;
  discount: number | null;
  amountDue: number | null;
  currency: string | null;

  // --- Líneas ---
  lines: Array<{
    description: string | null;
    productCode: string | null;
    quantity: number | null;
    unitPrice: number | null;
    total: number | null;
    tax?: number | null;
  }>;

  raw: any;
};

type AllowedContentType =
  | 'application/pdf'
  | 'application/octet-stream'
  | 'image/jpeg'
  | 'image/png'
  | 'image/tiff'
  | 'image/bmp'
  | 'image/heif'
  | 'text/html'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function toAllowedContentType(mt?: string): AllowedContentType {
  switch (mt) {
    case 'application/pdf':
    case 'image/jpeg':
    case 'image/png':
    case 'image/tiff':
    case 'image/bmp':
    case 'image/heif':
    case 'text/html':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return mt;
    default:
      return 'application/octet-stream';
  }
}

@Injectable()
export class AzureDocIntelService {
  private readonly logger = new Logger(AzureDocIntelService.name);
  private readonly client = createClient(
    envs.DOCINTEL_ENDPOINT!,
    new AzureKeyCredential(envs.DOCINTEL_KEY!),
  );

  async analyzeInvoiceFromBuffer(
    buffer: Buffer,
    mimetype = 'application/pdf',
  ): Promise<AzureInvoiceExtraction | null> {
    try {
      const contentType = toAllowedContentType(mimetype);

      const initial = await this.client
        .path('/documentModels/{modelId}:analyze', 'prebuilt-invoice')
        .post({
          contentType,
          body: buffer,
          queryParameters: { 'api-version': '2024-11-30' },
        });

      if (isUnexpected(initial)) {
        throw initial.body.error;
      }

      const poller = getLongRunningPoller(this.client, initial);
      const done = await poller.pollUntilDone();

      const out = done.body as AnalyzeOperationOutput;
      // En algunas versiones el tipo no declara analyzeResult; lo tomamos así:
      const analyzeResult = (out as any).analyzeResult;
      const doc = analyzeResult?.documents?.[0];
      if (!doc) return null;

      // ================================
      // Helpers v4 para DocumentFieldOutput
      // ================================
      type DF = DocumentFieldOutput;

      const str = (f?: DF | null) => f?.valueString ?? null;
      const num = (f?: DF | null) => (typeof f?.valueNumber === 'number' ? f.valueNumber : null);
      const dateI = (f?: DF | null) => (f?.valueDate ? new Date(f.valueDate).toISOString() : null);
      const curr = (f?: DF | null) => f?.valueCurrency?.amount ?? null;
      const obj = (f?: DF | null) => f?.valueObject ?? null;
      const arr = (f?: DF | null): DF[] | null => f?.valueArray ?? null;

      const fields = doc.fields as Record<string, DF>;

      // --- Proveedor ---
      const supplierName = str(fields['VendorName']);
      const supplierTaxIdRaw = str(fields['VendorTaxId']);

      // Dirección del proveedor: si viene estructurada (valueAddress), la aplanamos; si no, usamos string
      const supplierAddress = fields['VendorAddress']?.valueAddress
        ? [
            fields['VendorAddress'].valueAddress.road,
            fields['VendorAddress'].valueAddress.houseNumber,
            fields['VendorAddress'].valueAddress.postalCode,
            fields['VendorAddress'].valueAddress.city,
            fields['VendorAddress'].valueAddress.countryRegion,
          ]
            .filter(Boolean)
            .join(' ')
        : str(fields['VendorAddress']);

      const supplierRecipient = str(fields['VendorAddressRecipient']);

      // --- Cliente ---
      const customerName = str(fields['CustomerName']);
      const customerTaxIdRaw = str(fields['CustomerTaxId']);
      const customerAddress = str(fields['CustomerAddress']);
      const customerRecipient = str(fields['CustomerAddressRecipient']);
      const customerId = str(fields['CustomerId']);

      // --- Factura ---
      const invoiceNumber = str(fields['InvoiceId']);
      const issueDate = dateI(fields['InvoiceDate']);
      const dueDate = dateI(fields['DueDate']);
      const subtotal = curr(fields['SubTotal']) ?? num(fields['SubTotal']);
      const total = curr(fields['InvoiceTotal']) ?? num(fields['InvoiceTotal']);
      const taxes = curr(fields['TotalTax']) ?? num(fields['TotalTax']);
      const discount = curr(fields['TotalDiscount']) ?? num(fields['TotalDiscount']);
      const amountDue = curr(fields['AmountDue']) ?? num(fields['AmountDue']);

      const currencyCode =
        fields['AmountDue']?.valueCurrency?.currencyCode ??
        fields['InvoiceTotal']?.valueCurrency?.currencyCode ??
        fields['TotalTax']?.valueCurrency?.currencyCode ??
        fields['SubTotal']?.valueCurrency?.currencyCode ??
        null;

      // --- Líneas ---
      const items = arr(fields['Items']) ?? [];
      const lines = items.map((item: DF) => {
        const o = obj(item) ?? ({} as Record<string, DF>);
        return {
          description: str(o['Description']),
          productCode: str(o['ProductCode']),
          quantity: num(o['Quantity']),
          unitPrice: curr(o['UnitPrice']) ?? num(o['UnitPrice']),
          total: curr(o['Amount']) ?? num(o['Amount']),
          tax: curr(o['Tax']) ?? num(o['Tax']) ?? null,
        };
      });

      // --- Normalización de NIF/CIF/IVA (proveedor/cliente) ---
      const normalizeAndMaybeValidate = (raw: string | null) => {
        const n = normalizeSpanishTaxId(raw || undefined);
        // Si es NIF español válido, lo dejamos; si no, devolvemos el normalizado (para VAT ES u otros)
        return n && isValidSpanishNif(n) ? n : (n ?? null);
      };

      const supplierTaxId = normalizeAndMaybeValidate(supplierTaxIdRaw);
      const customerTaxId = normalizeAndMaybeValidate(customerTaxIdRaw);

      const extraction: AzureInvoiceExtraction = {
        // Proveedor
        supplierName,
        supplierTaxId,
        supplierAddress,
        supplierRecipient,

        // Cliente
        customerName,
        customerTaxId,
        customerAddress,
        customerRecipient,
        customerId,

        // Factura
        invoiceNumber,
        issueDate,
        dueDate,
        subtotal,
        total,
        taxes,
        discount,
        amountDue,
        currency: currencyCode,

        // Líneas
        lines,

        raw: analyzeResult,
      };

      return extraction;
    } catch (e: any) {
      this.logger.error(e?.message || e);
      throw new InternalServerErrorException('Azure Document Intelligence error');
    }
  }
}
