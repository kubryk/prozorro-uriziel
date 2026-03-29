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

  selectBestDocument(documents: ProzorroDocument[]): ProzorroDocument | null {
    const pdfs = documents.filter(
      (doc) => doc.format === 'application/pdf' || doc.url?.endsWith('.pdf'),
    );

    if (pdfs.length === 0) return null;

    // Prefer documents with "специфікація" or "договір" in title
    const specDoc = pdfs.find((doc) =>
      doc.title?.toLowerCase().includes('специфікація'),
    );
    if (specDoc) return specDoc;

    const contractDoc = pdfs.find((doc) =>
      doc.title?.toLowerCase().includes('договір'),
    );
    if (contractDoc) return contractDoc;

    // Fall back to the first PDF (usually the main document)
    return pdfs[0];
  }

  async downloadAndExtractPdf(documentUrl: string): Promise<string> {
    const response = await firstValueFrom(
      this.httpService.get<ArrayBuffer>(documentUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 30_000,
      }),
    );

    const buffer = Buffer.from(response.data);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return result.text;
  }

  extractSpecificationSection(fullText: string): string {
    // Find "Специфікація" in various forms
    const specPatterns = [
      /специфікація/i,
      /с\s*п\s*е\s*ц\s*и\s*ф\s*і\s*к\s*а\s*ц\s*і\s*я/i, // Spaced out letters
      /додаток.*специфікація/i,
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
      // No specification section found — return full text (LLM will handle it)
      this.logger.warn('Specification section not found in PDF, using full text');
      return fullText;
    }

    const textAfterSpec = fullText.substring(specIndex);

    // Find end of specification section
    let endIndex = textAfterSpec.length;
    for (const pattern of SECTION_END_PATTERNS) {
      // Skip the first match if it's right at the beginning (it might be the spec header itself)
      const match = textAfterSpec.substring(100).search(pattern);
      if (match !== -1 && match + 100 < endIndex) {
        endIndex = match + 100;
      }
    }

    return textAfterSpec.substring(0, endIndex);
  }
}
