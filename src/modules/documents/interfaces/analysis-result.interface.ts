export interface ExtractedLineItem {
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
  AdditionalReference?: string | null;
}

export interface ExtractionResult {
  supplierName: string | null;
  supplierTaxId: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  total: number | null;
  taxes: number | null;
  currency: string | null;
  lines: ExtractedLineItem[];
}

export interface DocumentSummary {
  id: string;
  status: string;
  enterpriseId: string;
  uploadedBy: string;
}
