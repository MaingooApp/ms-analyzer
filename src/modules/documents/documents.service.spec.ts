import { DocumentsService } from './documents.service';

describe('DocumentsService usage accounting', () => {
  it('links token usage rows when invoiceId arrives', async () => {
    const tx = {
      document: {
        update: jest.fn().mockResolvedValue({}),
      },
      documentTokenUsage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = {
      $transaction: jest.fn((callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
      logger: { log: jest.fn(), error: jest.fn() },
    } as unknown as DocumentsService;

    await DocumentsService.prototype.updateDocumentInvoiceId.call(
      service,
      'document-1',
      'invoice-1',
    );

    expect(tx.document.update).toHaveBeenCalledWith({
      where: { id: 'document-1' },
      data: { invoiceId: 'invoice-1' },
    });
    expect(tx.documentTokenUsage.updateMany).toHaveBeenCalledWith({
      where: { documentId: 'document-1' },
      data: { invoiceId: 'invoice-1' },
    });
  });

  it('returns document and token usage aggregated by enterprise and model', async () => {
    const service = {
      document: {
        count: jest.fn().mockResolvedValue(3),
      },
      documentTokenUsage: {
        count: jest.fn().mockResolvedValue(2),
        aggregate: jest.fn().mockResolvedValue({
          _sum: {
            inputTokens: 30,
            outputTokens: 7,
            totalTokens: 37,
          },
        }),
        groupBy: jest.fn().mockResolvedValue([
          {
            model: 'gpt-4.1',
            _count: { _all: 1 },
            _sum: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          },
          {
            model: 'gpt-4.1-mini',
            _count: { _all: 1 },
            _sum: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          },
        ]),
        findMany: jest.fn().mockResolvedValue([
          {
            documentId: 'document-1',
            invoiceId: 'invoice-1',
            model: 'gpt-4.1',
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            document: {
              id: 'document-1',
              filename: 'factura-1.pdf',
              documentType: 'supplier_invoice',
              status: 'DONE',
              invoiceId: 'invoice-1',
              processedAt: new Date('2026-06-26T10:00:00.000Z'),
              createdAt: new Date('2026-06-26T09:00:00.000Z'),
              extraction: {
                supplierName: 'Makro',
                invoiceNumber: 'INV-1',
                issueDate: new Date('2026-06-25T00:00:00.000Z'),
                totalAmount: { toNumber: () => 100.5 },
                currency: 'EUR',
              },
            },
          },
          {
            documentId: 'document-1',
            invoiceId: 'invoice-1',
            model: 'gpt-4.1-mini',
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            document: {
              id: 'document-1',
              filename: 'factura-1.pdf',
              documentType: 'supplier_invoice',
              status: 'DONE',
              invoiceId: 'invoice-1',
              processedAt: new Date('2026-06-26T10:00:00.000Z'),
              createdAt: new Date('2026-06-26T09:00:00.000Z'),
              extraction: {
                supplierName: 'Makro',
                invoiceNumber: 'INV-1',
                issueDate: new Date('2026-06-25T00:00:00.000Z'),
                totalAmount: { toNumber: () => 100.5 },
                currency: 'EUR',
              },
            },
          },
        ]),
      },
      buildUsageByDocument: (DocumentsService.prototype as any).buildUsageByDocument,
      handleError: (error: unknown) => error,
    } as unknown as DocumentsService;

    await expect(
      DocumentsService.prototype.getUsage.call(service, { enterpriseId: 'enterprise-1' }),
    ).resolves.toEqual({
      documents: 3,
      requests: 2,
      inputTokens: 30,
      outputTokens: 7,
      totalTokens: 37,
      byModel: [
        {
          model: 'gpt-4.1',
          requests: 1,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
        },
        {
          model: 'gpt-4.1-mini',
          requests: 1,
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
        },
      ],
      byDocument: [
        {
          documentId: 'document-1',
          invoiceId: 'invoice-1',
          filename: 'factura-1.pdf',
          documentType: 'supplier_invoice',
          status: 'DONE',
          supplierName: 'Makro',
          invoiceNumber: 'INV-1',
          issueDate: '2026-06-25T00:00:00.000Z',
          total: 100.5,
          currency: 'EUR',
          processedAt: '2026-06-26T10:00:00.000Z',
          createdAt: '2026-06-26T09:00:00.000Z',
          requests: 2,
          inputTokens: 30,
          outputTokens: 7,
          totalTokens: 37,
          byModel: [
            {
              model: 'gpt-4.1',
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
            },
            {
              model: 'gpt-4.1-mini',
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
            },
          ],
        },
      ],
    });
  });
});
