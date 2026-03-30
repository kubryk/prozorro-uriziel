import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PDFParse } from 'pdf-parse';
import { ProzorroService } from '../prozorro/prozorro.service';
import { ProzorroDocument } from '../prozorro/prozorro.types';

// Section headers that typically follow a specification section
const SECTION_END_PATTERNS = [
  /\n\s*\d+\.\s+[А-ЯІЇЄҐ]/,             // Numbered section header (e.g., "3. УМОВИ")
  /\n\s*(?:Розділ|РОЗДІЛ)\s+\d+/,         // "Розділ N"
  /\n\s*(?:Додаток|ДОДАТОК)\s+/,          // "Додаток"
  /\n\s*(?:ЗАГАЛЬНА ВАРТІСТЬ|Загальна вартість|Разом|РАЗОМ|Всього|ВСЬОГО)\s*[:：]/,
];

const TABLE_HEADER_PATTERNS = [
  /найменування/i,
  /(?:кількість|обсяг)/i,
  /(?:ціна|вартість)/i,
  /(?:одиниця|од\.?\s*виміру)/i,
];
const MAX_SCREENSHOT_PAGES = 8;

@Injectable()
export class PdfExtractorService {
  private readonly logger = new Logger(PdfExtractorService.name);

  constructor(
    private readonly prozorroApi: ProzorroService,
    private readonly httpService: HttpService,
  ) {}

  async fetchContractDocuments(contractId: string): Promise<ProzorroDocument[]> {
    return this.prozorroApi.getContractDocuments(contractId);
  }

  rankDocuments(documents: ProzorroDocument[]): ProzorroDocument[] {
    const pdfs = documents.filter(
      (doc) => doc.format === 'application/pdf' || doc.url?.endsWith('.pdf'),
    );

    if (pdfs.length === 0) return [];

    const specDocs = pdfs.filter((doc) =>
      doc.title?.toLowerCase().includes('специфікація'),
    );
    const contractDocs = pdfs.filter(
      (doc) =>
        !doc.title?.toLowerCase().includes('специфікація') &&
        doc.title?.toLowerCase().includes('договір'),
    );
    const rest = pdfs.filter(
      (doc) =>
        !doc.title?.toLowerCase().includes('специфікація') &&
        !doc.title?.toLowerCase().includes('договір'),
    );

    return [...specDocs, ...contractDocs, ...rest];
  }

  async downloadPdf(documentUrl: string): Promise<Buffer> {
    const response = await firstValueFrom(
      this.httpService.get<ArrayBuffer>(documentUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 30_000,
      }),
    );

    return Buffer.from(response.data);
  }

  private async withParser<T>(
    buffer: Buffer,
    handler: (parser: PDFParse) => Promise<T>,
  ): Promise<T> {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });

    try {
      return await handler(parser);
    } finally {
      await parser.destroy();
    }
  }

  async extractTextFromPdf(buffer: Buffer): Promise<string> {
    return this.withParser(buffer, async (parser) => {
      const result = await parser.getText({
        pageJoiner: '\n',
      });

      return result.text?.trim() || '';
    });
  }

  async renderPdfScreenshots(buffer: Buffer): Promise<string[]> {
    return this.withParser(buffer, async (parser) => {
      const result = await parser.getScreenshot({
        last: MAX_SCREENSHOT_PAGES,
        desiredWidth: 1600,
        imageDataUrl: false,
        imageBuffer: true,
      });

      return result.pages
        .map((page) => Buffer.from(page.data).toString('base64'))
        .filter((image) => image.length > 0);
    });
  }

  private trimSection(textAfterStart: string): string {
    let endIndex = textAfterStart.length;
    for (const pattern of SECTION_END_PATTERNS) {
      const match = textAfterStart.substring(100).search(pattern);
      if (match !== -1 && match + 100 < endIndex) {
        endIndex = match + 100;
      }
    }

    return textAfterStart.substring(0, endIndex);
  }

  private findTableSection(fullText: string): string | null {
    const lines = fullText.split(/\r?\n/);

    // Scan from the end — price tables are usually near the end of the document
    let lastMatch: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const windowText = lines.slice(i, i + 20).join('\n');
      const matchedHeaders = TABLE_HEADER_PATTERNS.filter((pattern) =>
        pattern.test(windowText),
      ).length;

      if (matchedHeaders >= 2) {
        const candidateSection = lines.slice(i, i + 250).join('\n');
        lastMatch = this.trimSection(candidateSection);
        i += 20; // skip ahead to avoid re-matching the same table header
      }
    }

    return lastMatch;
  }

  extractSpecificationSection(fullText: string): string | null {
    // Find "Специфікація" in various forms
    const specPatterns = [
      /специфікація/i,
      /с\s*п\s*е\s*ц\s*и\s*ф\s*і\s*к\s*а\s*ц\s*і\s*я/i, // Spaced out letters
      /додаток.*специфікація/i,
      /спецификация/i,          // Russian
      /специфік/i,              // Ukrainian prefix / truncated
      /таблиця\s*позицій/i,
      /перелік\s*товарів/i,
      /кошторис/i,
      /номенклатура/i,
    ];

    let specIndex = -1;
    for (const pattern of specPatterns) {
      const match = fullText.search(pattern);
      if (match !== -1) {
        specIndex = match;
        break;
      }
    }

    if (specIndex === -1) {
      const tableSection = this.findTableSection(fullText);
      if (tableSection) {
        this.logger.warn('Specification section not found in PDF, using detected pricing table');
        return tableSection;
      }

      this.logger.warn('Specification section not found in PDF, and no pricing table detected');
      return null;
    }

    const textAfterSpec = fullText.substring(specIndex);
    return this.trimSection(textAfterSpec);
  }
}
