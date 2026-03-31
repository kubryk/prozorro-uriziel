jest.mock('./mistral-ocr.service', () => ({
  MistralOcrService: class MistralOcrService {},
}));

import { PriceAnalysisService } from './price-analysis.service';

describe('PriceAnalysisService', () => {
  let prisma: any;
  let pdfExtractor: any;
  let gemini: any;
  let mistralOcr: any;
  let analysisQueue: any;
  let service: PriceAnalysisService;

  beforeEach(() => {
    prisma = {
      tender: {
        findUnique: jest.fn(),
      },
      contract: {
        findMany: jest.fn(),
      },
      priceAnalysis: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      priceAnalysisItem: {
        createMany: jest.fn(),
      },
    };

    pdfExtractor = {
      fetchContractDocuments: jest.fn(),
      rankDocuments: jest.fn(),
      downloadPdf: jest.fn(),
      extractTextFromPdf: jest.fn(),
      extractSpecificationSection: jest.fn(),
    };

    gemini = {
      isAvailable: true,
      extractItemsFromText: jest.fn(),
    };

    mistralOcr = {
      isAvailable: false,
      extractTextFromPdf: jest.fn(),
    };

    analysisQueue = {
      add: jest.fn(),
    };

    service = new PriceAnalysisService(
      prisma,
      pdfExtractor,
      gemini,
      mistralOcr,
      analysisQueue,
    );

    prisma.tender.findUnique.mockResolvedValue({ status: 'complete' });
    prisma.priceAnalysis.update.mockResolvedValue({});
    prisma.priceAnalysisItem.createMany.mockResolvedValue({ count: 1 });
  });

  it('не створює analysis job, якщо в контракту немає PDF-документів', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        id: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        status: 'active',
        amount: 1000,
        dateSigned: new Date('2026-03-01'),
      },
    ]);
    prisma.priceAnalysis.findFirst.mockResolvedValue(null);
    pdfExtractor.fetchContractDocuments.mockResolvedValue([]);
    pdfExtractor.rankDocuments.mockReturnValue([]);
    prisma.priceAnalysis.create.mockResolvedValue({ id: 'skipped-1' });

    const result = await service.triggerTenderAnalysis('tender-1', '123');

    expect(result.count).toBe(0);
    expect(result.analysisIds).toEqual([]);
    expect(result.startedContracts).toEqual([]);
    expect(result.skippedContracts).toEqual([
      {
        tenderId: 'tender-1',
        contractId: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        reason: 'У контракту немає PDF-документів для аналізу',
      },
    ]);
    expect(prisma.priceAnalysis.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contractId: 'contract-1',
        status: 'SKIPPED',
        errorMessage: 'У контракту немає PDF-документів для аналізу',
      }),
    });
    expect(analysisQueue.add).not.toHaveBeenCalled();
  });

  it('запускає аналіз лише для контрактів, де є PDF-документи', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        id: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        status: 'active',
        amount: 1000,
        dateSigned: new Date('2026-03-01'),
      },
      {
        id: 'contract-2',
        contractID: 'CID-2',
        contractNumber: '10/2',
        status: 'active',
        amount: 2000,
        dateSigned: new Date('2026-03-02'),
      },
    ]);
    prisma.priceAnalysis.findFirst.mockResolvedValue(null);
    pdfExtractor.fetchContractDocuments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ url: 'https://example.com/doc.pdf' }]);
    pdfExtractor.rankDocuments.mockImplementation((documents: any[]) =>
      documents.length > 0 ? documents : [],
    );
    prisma.priceAnalysis.create.mockResolvedValue({ id: 'analysis-2' });

    const result = await service.triggerTenderAnalysis('tender-1', '123');

    expect(result.count).toBe(1);
    expect(result.analysisIds).toEqual(['analysis-2']);
    expect(result.startedContracts).toEqual([
      {
        tenderId: 'tender-1',
        contractId: 'contract-2',
        contractID: 'CID-2',
        contractNumber: '10/2',
        state: 'QUEUED',
      },
    ]);
    expect(result.skippedContracts).toHaveLength(1);
    expect(result.skippedContracts[0]).toMatchObject({
      contractId: 'contract-1',
      reason: 'У контракту немає PDF-документів для аналізу',
    });
    expect(prisma.priceAnalysis.create).toHaveBeenCalledTimes(2);
    expect(analysisQueue.add).toHaveBeenCalledWith(
      'analyze-contract',
      { analysisId: 'analysis-2' },
      expect.objectContaining({
        jobId: 'analysis-analysis-2',
      }),
    );
  });

  it('пропускає всі контракти, якщо тендер скасований', async () => {
    prisma.tender.findUnique.mockResolvedValue({ status: 'cancelled' });
    prisma.contract.findMany.mockResolvedValue([
      {
        id: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        status: 'active',
        amount: 1000,
        dateSigned: new Date('2026-03-01'),
      },
    ]);
    prisma.priceAnalysis.findFirst.mockResolvedValue(null);
    prisma.priceAnalysis.create.mockResolvedValue({ id: 'skipped-1' });

    const result = await service.triggerTenderAnalysis('tender-1', '123');

    expect(result.count).toBe(0);
    expect(result.analysisIds).toEqual([]);
    expect(result.startedContracts).toEqual([]);
    expect(result.skippedContracts).toEqual([
      {
        tenderId: 'tender-1',
        contractId: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        reason: 'Тендер має статус "cancelled", аналіз недоречний',
      },
    ]);
    expect(pdfExtractor.fetchContractDocuments).not.toHaveBeenCalled();
    expect(prisma.priceAnalysis.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contractId: 'contract-1',
        status: 'SKIPPED',
        errorMessage: 'Тендер має статус "cancelled", аналіз недоречний',
      }),
    });
  });

  it('пропускає скасований або непідписаний контракт ще до перевірки документів', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        id: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        status: 'cancelled',
        amount: 1000,
        dateSigned: new Date('2026-03-01'),
      },
      {
        id: 'contract-2',
        contractID: 'CID-2',
        contractNumber: '10/2',
        status: 'pending',
        amount: 1000,
        dateSigned: null,
      },
    ]);
    prisma.priceAnalysis.findFirst.mockResolvedValue(null);
    prisma.priceAnalysis.create
      .mockResolvedValueOnce({ id: 'skipped-1' })
      .mockResolvedValueOnce({ id: 'skipped-2' });

    const result = await service.triggerTenderAnalysis('tender-1', '123');

    expect(result.count).toBe(0);
    expect(result.startedContracts).toEqual([]);
    expect(result.skippedContracts).toEqual([
      {
        tenderId: 'tender-1',
        contractId: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        reason: 'Контракт має статус "cancelled", аналіз недоречний',
      },
      {
        tenderId: 'tender-1',
        contractId: 'contract-2',
        contractID: 'CID-2',
        contractNumber: '10/2',
        reason:
          'Контракт ще не підписаний або не набрав чинності (статус "pending")',
      },
    ]);
    expect(pdfExtractor.fetchContractDocuments).not.toHaveBeenCalled();
    expect(prisma.priceAnalysis.create).toHaveBeenCalledTimes(2);
  });

  it('повертає контракт як already in progress, якщо аналіз уже виконується', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        id: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        status: 'active',
        amount: 1000,
        dateSigned: new Date('2026-03-01'),
      },
    ]);
    prisma.priceAnalysis.findFirst.mockResolvedValue({
      id: 'analysis-existing',
      status: 'SEARCHING_PRICES',
    });

    const result = await service.triggerTenderAnalysis('tender-1', '123');

    expect(result.count).toBe(1);
    expect(result.analysisIds).toEqual(['analysis-existing']);
    expect(result.startedContracts).toEqual([
      {
        tenderId: 'tender-1',
        contractId: 'contract-1',
        contractID: 'CID-1',
        contractNumber: '10/1',
        state: 'IN_PROGRESS',
      },
    ]);
    expect(result.skippedContracts).toEqual([]);
    expect(pdfExtractor.fetchContractDocuments).not.toHaveBeenCalled();
    expect(prisma.priceAnalysis.create).not.toHaveBeenCalled();
    expect(analysisQueue.add).not.toHaveBeenCalled();
  });

  it('переходить до наступного PDF, якщо попередній падає на етапі витягування', async () => {
    prisma.priceAnalysis.findUnique.mockResolvedValue({
      id: 'analysis-1',
      contractId: 'contract-1',
      contract: {
        items: [],
        tender: { customerRegion: 'Kyiv' },
      },
    });

    const documents = [
      { id: 'doc-1', title: 'Broken spec', url: 'https://example.com/bad.pdf' },
      { id: 'doc-2', title: 'Good spec', url: 'https://example.com/good.pdf' },
    ];

    pdfExtractor.fetchContractDocuments.mockResolvedValue(documents);
    pdfExtractor.rankDocuments.mockReturnValue(documents);
    pdfExtractor.downloadPdf
      .mockResolvedValueOnce(Buffer.from('bad-pdf'))
      .mockResolvedValueOnce(Buffer.from('good-pdf'));
    pdfExtractor.extractTextFromPdf
      .mockResolvedValueOnce(
        'Додаток 1. Специфікація\nНайменування товару Кількість Одиниця виміру Ціна\nШприц 100 шт 12.50',
      )
      .mockResolvedValueOnce(
        'Додаток 2. Специфікація\nНайменування товару Кількість Одиниця виміру Ціна\nШприц 100 шт 12.50',
      );
    pdfExtractor.extractSpecificationSection.mockReturnValue(
      'Найменування товару Кількість Одиниця виміру Ціна\nШприц 100 шт 12.50',
    );
    gemini.extractItemsFromText
      .mockRejectedValueOnce(new Error('Gemini returned malformed JSON'))
      .mockResolvedValueOnce([
        {
          itemName: 'Шприц одноразовий',
          unitPrice: 12.5,
          quantity: 100,
          unit: 'шт',
        },
      ]);

    await expect(
      service.runAnalysisPipeline('analysis-1'),
    ).resolves.toBeUndefined();

    expect(gemini.extractItemsFromText).toHaveBeenCalledTimes(2);
    expect(prisma.priceAnalysisItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          analysisId: 'analysis-1',
          itemName: 'Шприц одноразовий',
          unitPrice: 12.5,
          quantity: 100,
          unit: 'шт',
        },
      ],
    });

    const updateCalls = prisma.priceAnalysis.update.mock.calls.map(
      ([payload]: [any]) => payload,
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            sourceDocumentTitle: 'Good spec',
            sourceDocumentUrl: 'https://example.com/good.pdf',
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'COMPLETE',
            totalItems: 1,
          }),
        }),
      ]),
    );
  });
});
