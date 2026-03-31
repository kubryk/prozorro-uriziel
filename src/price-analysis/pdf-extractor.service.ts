import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PDFParse } from 'pdf-parse';
import { ProzorroService } from '../prozorro/prozorro.service';
import { ProzorroDocument } from '../prozorro/prozorro.types';

// Section headers that typically follow a specification section
const SECTION_END_PATTERNS = [
  /\n\s*\d+\.\s+[А-ЯІЇЄҐ]/, // Numbered section header (e.g., "3. УМОВИ")
  /\n\s*(?:Розділ|РОЗДІЛ)\s+\d+/, // "Розділ N"
  /\n\s*(?:Додаток|ДОДАТОК)\s+/, // "Додаток"
  /\n\s*(?:ЗАГАЛЬНА ВАРТІСТЬ|Загальна вартість|Разом|РАЗОМ|Всього|ВСЬОГО)\s*[:：\s]/,
];

const TABLE_HEADER_PATTERNS = [
  /найменування/i,
  /(?:кількість|обсяг)/i,
  /(?:ціна|вартість)/i,
  /(?:одиниця|од\.?\s*виміру)/i,
];
const MAX_SECTION_LENGTH = 15_000;
const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const PRICE_VALUE_PATTERN = /\b\d+[.,]\d{2}\b/g;

@Injectable()
export class PdfExtractorService {
  private readonly logger = new Logger(PdfExtractorService.name);

  constructor(
    private readonly prozorroApi: ProzorroService,
    private readonly httpService: HttpService,
  ) {}

  async fetchContractDocuments(
    contractId: string,
  ): Promise<ProzorroDocument[]> {
    return this.prozorroApi.getContractDocuments(contractId);
  }

  private hasPdfLikeName(value: string | undefined): boolean {
    if (!value) {
      return false;
    }

    try {
      return new URL(value).pathname.toLowerCase().endsWith('.pdf');
    } catch {
      return /\.pdf(?:$|[?#])/i.test(value.trim());
    }
  }

  private isPdfDocument(doc: ProzorroDocument): boolean {
    if (!doc.url) {
      return false;
    }

    const normalizedFormat = doc.format?.trim().toLowerCase();
    return (
      normalizedFormat?.startsWith('application/pdf') === true ||
      this.hasPdfLikeName(doc.url) ||
      this.hasPdfLikeName(doc.title)
    );
  }

  rankDocuments(documents: ProzorroDocument[]): ProzorroDocument[] {
    const pdfs = documents.filter((doc) => this.isPdfDocument(doc));

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
        maxContentLength: MAX_PDF_SIZE_BYTES,
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

  private trimSection(textAfterStart: string): string {
    let endIndex = Math.min(textAfterStart.length, MAX_SECTION_LENGTH);
    for (const pattern of SECTION_END_PATTERNS) {
      const match = textAfterStart.search(pattern);
      if (match !== -1 && match < endIndex) {
        endIndex = match;
      }
    }

    return textAfterStart.substring(0, endIndex);
  }

  private countTableHeaderMatches(text: string): number {
    return TABLE_HEADER_PATTERNS.filter((pattern) => pattern.test(text)).length;
  }

  private countPriceLikeValues(text: string): number {
    return text.match(PRICE_VALUE_PATTERN)?.length ?? 0;
  }

  private isLikelyTableOfContentsCandidate(text: string): boolean {
    const [firstLine = ''] = text.split(/\r?\n/, 1);
    return /\.{2,}\s*\d+\s*$/.test(firstLine);
  }

  private scoreSpecificationCandidate(
    candidate: string,
    matchIndex: number,
  ): number {
    const tableHeaderScore = this.countTableHeaderMatches(candidate) * 100;
    const priceScore = Math.min(this.countPriceLikeValues(candidate), 5) * 10;
    const lengthScore = Math.min(candidate.length, MAX_SECTION_LENGTH) / 100;
    const positionScore = matchIndex / 1_000;
    const tocPenalty = this.isLikelyTableOfContentsCandidate(candidate)
      ? 200
      : 0;

    return (
      tableHeaderScore + priceScore + lengthScore + positionScore - tocPenalty
    );
  }

  private findTableSection(fullText: string): string | null {
    const lines = fullText.split(/\r?\n/);

    // Walk the document and keep the latest table-like match —
    // price tables are usually near the end of the document.
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
      /специфікація/gi,
      /с\s*п\s*е\s*ц\s*и\s*ф\s*і\s*к\s*а\s*ц\s*і\s*я/gi, // Spaced out letters
      /додаток.*специфікація/gi,
      /спецификация/gi, // Russian
      /специфік/gi, // Ukrainian prefix / truncated
      /таблиця\s*позицій/gi,
      /перелік\s*товарів/gi,
      /кошторис/gi,
      /номенклатура/gi,
    ];

    // Score every candidate section so table-like content wins over
    // a table-of-contents mention, while later matches still get a small boost.
    let bestCandidate: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const pattern of specPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(fullText)) !== null) {
        const candidate = this.trimSection(fullText.substring(match.index));
        const score = this.scoreSpecificationCandidate(candidate, match.index);

        if (!bestCandidate || score > bestScore) {
          bestCandidate = candidate;
          bestScore = score;
        }
      }
    }

    if (bestCandidate) {
      return bestCandidate;
    }

    const tableSection = this.findTableSection(fullText);
    if (tableSection) {
      this.logger.warn(
        'Specification section not found in PDF, using detected pricing table',
      );
      return tableSection;
    }

    this.logger.warn(
      'Specification section not found in PDF, and no pricing table detected',
    );
    return null;
  }
}
