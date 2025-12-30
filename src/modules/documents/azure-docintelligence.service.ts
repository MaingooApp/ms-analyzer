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

  async analyzeInvoiceFromBuffer(
    buffer: Buffer,
    mimetype = 'application/pdf',
    documentUrl: string,
  ): Promise<AzureInvoiceExtraction | null> {
    try {
      const url = `${this.endpoint}/contentunderstanding/analyzers/Analizer_GA:analyze?api-version=2025-11-01`;

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

      if (!postResp.ok && postResp.status !== 202) {
        throw new Error(await postResp.text());
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

        resultJson = await getResp.json();
        status = resultJson.status;

        if (status === 'Running' || status === 'NotStarted') {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }

      if (status !== 'Succeeded') {
        throw new Error(`Analysis failed, status: ${status}`);
      }

      const content = resultJson.result?.contents?.[0];

      if (!content) return null;

      const fields = content.fields as Record<string, CUField>;

      const str = (f?: CUField) => f?.valueString ?? null;
      const num = (f?: CUField) => {
        if (typeof f?.valueNumber === 'number') return f.valueNumber;
        if (typeof f?.valueInteger === 'number') return f.valueInteger;
        return null;
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
        const unitPrice = num(o['LinePrice']) ?? num(o['UnitPrice']);
        
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
          DiscountCode: str(o['DiscountCode']),
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
}
