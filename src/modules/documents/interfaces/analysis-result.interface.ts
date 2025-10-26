export interface ExtractedLineItem {
  description: string | null;
  productCode: string | null;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
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
