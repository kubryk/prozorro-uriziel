import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Mistral } from '@mistralai/mistralai';

const MISTRAL_OCR_MODEL = 'mistral-ocr-latest';

@Injectable()
export class MistralOcrService implements OnModuleInit {
  private readonly logger = new Logger(MistralOcrService.name);
  private client: Mistral | null = null;

  onModuleInit() {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      this.logger.warn('MISTRAL_API_KEY not set — Mistral OCR fallback will not be available');
      return;
    }
    this.client = new Mistral({ apiKey });
    this.logger.log('Mistral OCR configured');
  }

  get isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Run OCR on a PDF buffer using Mistral OCR API.
   * Returns the extracted text as markdown, or null if not configured or failed.
   */
  async extractTextFromPdf(buffer: Buffer): Promise<string | null> {
    if (!this.client) {
      return null;
    }

    try {
      const base64 = buffer.toString('base64');
      const response = await this.client.ocr.process({
        model: MISTRAL_OCR_MODEL,
        document: {
          type: 'document_url',
          documentUrl: `data:application/pdf;base64,${base64}`,
        },
      });

      const text = response.pages
        .map((page) => page.markdown)
        .filter((md) => md && md.trim().length > 0)
        .join('\n\n');

      this.logger.log(
        `Mistral OCR: extracted ${text.length} chars from ${response.pages.length} pages`,
      );

      return text.trim() || null;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mistral OCR failed: ${msg}`);
      return null;
    }
  }
}
