import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { normalizeSpanishTaxId } from 'src/common/utils/taxid';
import { isValidSpanishNif } from 'src/common/utils';
import { envs } from 'src/config';

export type CUField = {
  type?: string;
  valueString?: string;
  valueNumber?: number;
  valueInteger?: number;
  valueDate?: string;
  valueArray?: CUField[];
  valueObject?: Record<string, CUField>;
};

export type AzureInvoiceExtraction = {
  CompanyName: string | null;
  CompanyAddress: string | null;
  CompanyTaxId: string | null;

  BranchName: string | null;
  BranchAddress: string | null;
  BranchPhoneNumber: string | null;
  BranchFaxNumber: string | null;

  // --- Cliente ---
  CustomerName: string | null;
  CustomerAddress: string | null;
  CustomerTaxId: string | null;
  CustomerCode: string | null;

  // --- Factura / fechas ---
  InvoiceNumber: string | null;
  InvoiceReference: string | null;

  SaleDate: string | null;
  SaleTime: string | null;
  PrintDate: string | null;
  PrintTime: string | null;
  DeliveryDate: string | null;
  DeliveryTime: string | null;

  // --- Totales ---
  TotalAmount: number | null;
  TotalTaxAmount: number | null;
  TotalDiscountAmount: number | null;
  CashPaymentAmount: number | null;
  CashChangeAmount: number | null;

  PackageCount: number | null;
  TotalWeightKg: string | null;
  ContainerCount: number | null;

  // --- Líneas ---
  Items: Array<{
    ProductCode: string | null;
    ProductDescription: string | null;
    ProductUnit: string | null;
    UnitPrice: number | null;
    UnitCount: string | null;
    LinePrice: number | null;
    Quantity: number | null;
    LineAmount: number | null;
    TaxIndicator: string | null;
    DiscountCode: string | null;
    AdditionalReference: string | null;
  }>;

  // --- Resumen impuestos ---
  TaxSummary: Array<{
    TaxBaseAmount: number | null;
    TaxRate: string | null;
    TaxAmount: number | null;
  }>;

  raw: any;
};

@Injectable()
export class AzureDocIntelService {
  private readonly logger = new Logger(AzureDocIntelService.name);
  private readonly endpoint = envs.cuEndpoint;
  private readonly key = envs.cuKey;
  private readonly MAX_RETRIES = 3;
  private readonly POLLING_INTERVAL_MS = 3000;

  async analyzeInvoiceFromBuffer(
    buffer: Buffer,
    mimetype = 'application/pdf',
    documentUrl: string,
  ): Promise<AzureInvoiceExtraction | null> {
    return this.analyzeWithRetry(buffer, mimetype, documentUrl, 0);
  }

  private async analyzeWithRetry(
    buffer: Buffer,
    mimetype: string,
    documentUrl: string,
    retryCount: number,
  ): Promise<AzureInvoiceExtraction | null> {
    try {
      const url = `${this.endpoint}/contentunderstanding/analyzers/InvoiceRouter:analyze?api-version=2025-11-01`;

      const body = {
        inputs: [
          {
            url: documentUrl,
          },
        ],
      };

      const postResp = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (postResp.status === 429) {
        const retryAfter = postResp.headers.get('Retry-After');
        const waitTime = retryAfter
          ? parseInt(retryAfter) * 1000
          : this.calculateBackoff(retryCount);

        if (retryCount < this.MAX_RETRIES) {
          this.logger.warn(
            `⏱️ Rate limit (429) alcanzado. Reintentando en ${waitTime}ms (intento ${retryCount + 1}/${this.MAX_RETRIES})`,
          );
          await this.sleep(waitTime);
          return this.analyzeWithRetry(buffer, mimetype, documentUrl, retryCount + 1);
        } else {
          throw new Error(`Rate limit (429) superado después de ${this.MAX_RETRIES} reintentos`);
        }
      }

      if (!postResp.ok && postResp.status !== 202) {
        const errorText = await postResp.text();
        throw new Error(`Azure API error (${postResp.status}): ${errorText}`);
      }

      const operationLocation = postResp.headers.get('Operation-Location');
      if (!operationLocation) throw new Error('Missing Operation-Location');

      let status = 'NotStarted';
      let resultJson: any = null;

      while (status === 'NotStarted' || status === 'Running') {
        const getResp = await fetch(operationLocation, {
          method: 'GET',
          headers: {
            'Ocp-Apim-Subscription-Key': this.key,
          },
        });

        if (getResp.status === 429) {
          const retryAfter = getResp.headers.get('Retry-After');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
          this.logger.warn(`⏱️ Rate limit en polling. Esperando ${waitTime}ms`);
          await this.sleep(waitTime);
          continue;
        }

        resultJson = await getResp.json();
        status = resultJson.status;

        if (status === 'Running' || status === 'NotStarted') {
          await this.sleep(this.POLLING_INTERVAL_MS);
        }
      }

      if (status !== 'Succeeded') {
        throw new Error(`Analysis failed, status: ${status}`);
      }

      const content =
        resultJson.result?.contents?.find((c: any) => c.category && c.fields) ||
        resultJson.result?.contents?.[1] ||
        resultJson.result?.contents?.[0];

      if (!content) return null;

      const fields = content.fields as Record<string, CUField>;

      const str = (f?: CUField) => f?.valueString ?? null;
      const num = (f?: CUField) => {
        if (typeof f?.valueNumber === 'number') return f.valueNumber;
        if (typeof f?.valueInteger === 'number') return f.valueInteger;
        return null;
      };

      const parseEuropeanPrice = (f?: CUField): number | null => {
        const strValue = str(f);
        if (!strValue) return null;

        const normalized = strValue.replace(',', '.');
        const parsed = parseFloat(normalized);

        return isNaN(parsed) ? null : parsed;
      };

      const dateI = (f?: CUField) => (f?.valueDate ? new Date(f.valueDate).toISOString() : null);
      const obj = (f?: CUField) => f?.valueObject ?? null;
      const arr = (f?: CUField) => f?.valueArray ?? null;

      const extraction: AzureInvoiceExtraction = {
        CompanyName: str(fields['CompanyName']),
        CompanyAddress: str(fields['CompanyAddress']),
        CompanyTaxId: null!,

        BranchName: str(fields['BranchName']),
        BranchAddress: str(fields['BranchAddress']),
        BranchPhoneNumber: str(fields['BranchPhoneNumber']),
        BranchFaxNumber: str(fields['BranchFaxNumber']),

        CustomerName: str(fields['CustomerName']),
        CustomerAddress: str(fields['CustomerAddress']),
        CustomerTaxId: null!,
        CustomerCode: str(fields['CustomerCode']),

        InvoiceNumber: str(fields['InvoiceNumber']),
        InvoiceReference: str(fields['InvoiceReference']),

        SaleDate: dateI(fields['SaleDate']),
        SaleTime: str(fields['SaleTime']),
        PrintDate: dateI(fields['PrintDate']),
        PrintTime: str(fields['PrintTime']),
        DeliveryDate: dateI(fields['DeliveryDate']),
        DeliveryTime: str(fields['DeliveryTime']),

        TotalAmount: num(fields['TotalAmount']),
        TotalTaxAmount: num(fields['TotalTaxAmount']),
        TotalDiscountAmount: num(fields['TotalDiscountAmount']),
        CashPaymentAmount: num(fields['CashPaymentAmount']),
        CashChangeAmount: num(fields['CashChangeAmount']),

        PackageCount: num(fields['PackageCount']),
        TotalWeightKg: str(fields['TotalWeightKg']),
        ContainerCount: num(fields['ContainerCount']),

        Items: [],
        TaxSummary: [],

        raw: resultJson.result,
      };

      const items = arr(fields['Items']) ?? [];
      extraction.Items = items.map((item) => {
        const o = obj(item) ?? {};
        const unitPrice = parseEuropeanPrice(o['UnitPrice']);
        const discount = num(o['Discount']);

        return {
          ProductCode: str(o['ProductCode']),
          ProductDescription: str(o['ProductDescription']),
          ProductUnit: str(o['ProductUnit']),
          UnitPrice: unitPrice,
          UnitCount: str(o['UnitCount']),
          LinePrice: num(o['LinePrice']),
          Quantity: num(o['Quantity']),
          LineAmount: num(o['LineAmount']),
          TaxIndicator: str(o['TaxIndicator']),
          DiscountCode: (discount !== null ? String(discount) : null) ?? str(o['DiscountCode']),
          AdditionalReference: str(o['AdditionalReference']),
        };
      });

      const taxSummary = arr(fields['TaxSummary']) ?? [];
      extraction.TaxSummary = taxSummary.map((t) => {
        const o = obj(t) ?? {};
        return {
          TaxBaseAmount: num(o['TaxBaseAmount']),
          TaxRate: str(o['TaxRate']),
          TaxAmount: num(o['TaxAmount']),
        };
      });

      const normalizeMaybe = (raw: string | null) => {
        const n = normalizeSpanishTaxId(raw || undefined);
        return n && isValidSpanishNif(n) ? n : (n ?? null);
      };

      extraction.CompanyTaxId = normalizeMaybe(str(fields['CompanyTaxId']));
      extraction.CustomerTaxId = normalizeMaybe(str(fields['CustomerTaxId']));

      return extraction;
    } catch (e: any) {
      const msg = e?.message ?? 'Azure Content Understanding error';
      this.logger.error(msg);
      throw new InternalServerErrorException(msg);
    }
  }

  private calculateBackoff(retryCount: number): number {
    const baseDelay = 5000;
    const exponentialDelay = baseDelay * Math.pow(2, retryCount);
    const jitter = Math.random() * 2000 * (retryCount + 1);
    return exponentialDelay + jitter;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
