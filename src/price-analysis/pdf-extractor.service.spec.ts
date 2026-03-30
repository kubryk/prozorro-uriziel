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
});
