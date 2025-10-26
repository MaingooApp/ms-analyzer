export const NATS_SERVICE = 'NATS_SERVICE';

export const AnalyzerSubjects = {
  submit: 'analyzer.submit',
  getById: 'analyzer.getById',
  health: 'analyzer.health.check',
} as const;

export const AnalyzerEvents = {
  analyzed: 'documents.analyzed',
  failed: 'documents.analysis.failed',
} as const;

export const SuppliersEvents = {
  invoiceProcessed: 'suppliers.invoice.processed',
} as const;
