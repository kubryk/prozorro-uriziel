import { NotFoundException } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchContractsQueryDto } from './dto/search-contracts-query.dto';
import { SearchTendersQueryDto } from './dto/search-tenders-query.dto';

describe('SearchController', () => {
  let controller: SearchController;
  let searchService: jest.Mocked<SearchService>;

  beforeEach(() => {
    searchService = {
      searchTenders: jest.fn(),
      searchContracts: jest.fn(),
      getCompanyProfile: jest.fn(),
      getStats: jest.fn(),
    } as unknown as jest.Mocked<SearchService>;

    controller = new SearchController(searchService);
  });

  it('передає DTO пошуку тендерів у сервіс без ручного парсингу в контролері', async () => {
    searchService.searchTenders.mockResolvedValue({
      data: [],
      total: 0,
      relatedContractTotal: 0,
      skip: 5,
      take: 100,
    });
    const query: SearchTendersQueryDto = {
      edrpou: '12345678',
      role: ['supplier'],
      status: ['active'],
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      dateType: 'dateModified',
      priceFrom: 100.5,
      priceTo: 500.9,
      skip: 5,
      take: 100,
    };

    await controller.searchTenders(query);

    expect(searchService.searchTenders).toHaveBeenCalledWith(query);
  });

  it('передає DTO пошуку контрактів у сервіс', async () => {
    searchService.searchContracts.mockResolvedValue({
      data: [],
      total: 0,
      relatedTenderTotal: 0,
      skip: 0,
      take: 20,
    });
    const query: SearchContractsQueryDto = {
      edrpou: '12345678',
      role: ['supplier', 'customer'],
      status: ['active', 'terminated'],
      dateFrom: '2026-02-01',
      dateTo: '2026-02-28',
      dateType: 'dateSigned',
      priceFrom: 1000,
      priceTo: 9000,
      skip: 0,
      take: 20,
    };

    await controller.searchContracts(query);

    expect(searchService.searchContracts).toHaveBeenCalledWith(query);
  });

  it('повертає профіль компанії за ЄДРПОУ', async () => {
    const profile = {
      edrpou: '12345678',
      name: 'Test Company',
      region: 'Київська',
      locality: 'Київ',
      asCustomer: { tenderCount: 5, totalAmount: 100000 },
      asSupplier: { contractCount: 3, totalAmount: 50000, bidCount: 10, winRate: 0.3 },
      complaints: { against: 2, by: 1 },
      recentTenders: [],
      recentContracts: [],
    };
    searchService.getCompanyProfile.mockResolvedValue(profile);

    await expect(controller.getCompanyProfile('12345678')).resolves.toEqual(profile);
    expect(searchService.getCompanyProfile).toHaveBeenCalledWith('12345678');
  });

  it('кидає NotFoundException, якщо компанію не знайдено', async () => {
    searchService.getCompanyProfile.mockResolvedValue(null);

    await expect(controller.getCompanyProfile('99999999')).rejects.toThrow(NotFoundException);
  });

  it('делегує отримання статистики сервісу', async () => {
    searchService.getStats.mockResolvedValue({
      tenders: 10,
      contracts: 20,
      lastSync: null,
    });

    await expect(controller.getStats()).resolves.toEqual({
      tenders: 10,
      contracts: 20,
      lastSync: null,
    });
    expect(searchService.getStats).toHaveBeenCalledTimes(1);
  });
});
