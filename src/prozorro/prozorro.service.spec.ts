import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { ProzorroService } from './prozorro.service';

describe('ProzorroService', () => {
  let service: ProzorroService;
  let httpService: {
    get: jest.Mock;
  };

  beforeEach(() => {
    jest.spyOn(global, 'setInterval').mockImplementation(() => 0 as any);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    httpService = {
      get: jest.fn(),
    };

    service = new ProzorroService(httpService as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('повертає сторінку тендерів разом з next_page offset', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          data: [{ id: 'tender-1' }],
          next_page: { offset: 'next-offset' },
        },
      }),
    );

    await expect(service.getTendersPage('current-offset')).resolves.toEqual({
      data: [{ id: 'tender-1' }],
      nextPageOffset: 'next-offset',
    });
    expect(httpService.get).toHaveBeenCalledWith(
      'https://public.api.openprocurement.org/api/2.5/tenders?offset=current-offset',
    );
  });

  it('URL-енкодить offset зі спецсимволами, щоб не ламати пагінацію Prozorro', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          data: [],
          next_page: { offset: 'next-offset' },
        },
      }),
    );

    await service.getTendersPage('2025-01-01T00:00:00+02:00');

    expect(httpService.get).toHaveBeenCalledWith(
      'https://public.api.openprocurement.org/api/2.5/tenders?offset=2025-01-01T00%3A00%3A00%2B02%3A00',
    );
  });

  it('отримує деталі контракту з окремого API endpoint', async () => {
    httpService.get.mockReturnValue(
      of({
        data: {
          data: { id: 'contract-1', status: 'active' },
        },
      }),
    );

    await expect(
      service.getContractDetails('contract-1'),
    ).resolves.toEqual({
      id: 'contract-1',
      status: 'active',
    });
    expect(httpService.get).toHaveBeenCalledWith(
      'https://public.api.openprocurement.org/api/2.5/contracts/contract-1',
    );
  });
});
