export const NATS_SERVICE = 'NATS_SERVICE';

export const AnalyzerSubjects = {
  submit: 'analyzer.submit',
  submitBatch: 'analyzer.submit.batch',
  getById: 'analyzer.getById',
  health: 'analyzer.health.check',
} as const;

export const AnalyzerEvents = {
  analyzed: 'documents.analyzed',
} as const;

export const SuppliersEvents = {
  invoiceProcessed: 'suppliers.invoice.processed',
} as const;

export const SuppliersSubjects = {
  checkInvoiceExists: 'invoices.checkExists',
} as const;
