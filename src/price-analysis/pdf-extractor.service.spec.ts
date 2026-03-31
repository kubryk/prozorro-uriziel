import { PdfExtractorService } from './pdf-extractor.service';

describe('PdfExtractorService', () => {
  const service = new PdfExtractorService({} as any, {} as any);

  it('повертає секцію специфікації, якщо вона явно є в документі', () => {
    const text = `
ДОГОВІР

Додаток 1. Специфікація
Найменування товару    Кількість    Одиниця виміру    Ціна
Шприц одноразовий      100          шт                12.50
Рукавички нітрилові    50           уп                80.00

3. Умови оплати
Оплата проводиться...
`;

    const result = service.extractSpecificationSection(text);

    expect(result).toContain('Шприц одноразовий');
    expect(result).not.toContain('Умови оплати');
  });

  it('повертає null, якщо в документі немає специфікації або таблиці з цінами', () => {
    const text = `
ДОГОВІР № 12
Предмет договору: Послуги з технічного обслуговування та ремонту комп'ютерного обладнання.
Загальна вартість договору: 10 000,00 грн.
Сторони погодили строки та порядок надання послуг.
`;

    const result = service.extractSpecificationSection(text);

    expect(result).toBeNull();
  });

  it('ігнорує згадку специфікації у змісті та бере реальну таблицю нижче', () => {
    const text = `
ЗМІСТ
1. Вступ
2. Специфікація ........ 15
3. Інше

${'А'.repeat(180)}

Додаток 1. Специфікація
Найменування товару    Кількість    Одиниця виміру    Ціна
Шприц одноразовий      100          шт                12.50

3. Умови оплати
`;

    const result = service.extractSpecificationSection(text);

    expect(result).toContain('Шприц одноразовий');
    expect(result).not.toContain('Специфікація ........ 15');
  });

  it('розпізнає PDF за mime, url з query та назвою файлу', () => {
    const ranked = service.rankDocuments([
      {
        id: 'spec',
        title: 'Специфікація',
        url: 'https://example.com/download?id=1',
        format: 'APPLICATION/PDF',
      },
      {
        id: 'contract',
        title: 'Договір.PDF',
        url: 'https://example.com/file?id=2',
      },
      {
        id: 'appendix',
        title: 'Додаток',
        url: 'https://example.com/files/spec.pdf?signature=abc',
      },
      {
        id: 'image',
        title: 'scan.jpg',
        url: 'https://example.com/files/scan.jpg',
        format: 'image/jpeg',
      },
      {
        id: 'missing-url',
        title: 'spec.pdf',
      },
    ] as any);

    expect(ranked.map((doc) => doc.id)).toEqual([
      'spec',
      'contract',
      'appendix',
    ]);
  });
});
