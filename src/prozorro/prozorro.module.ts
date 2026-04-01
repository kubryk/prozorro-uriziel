import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import * as https from 'https';
import { ProzorroService } from './prozorro.service';

@Module({
  imports: [
    HttpModule.register({
      // Disable keep-alive to prevent ECONNRESET when the server closes idle connections
      httpsAgent: new https.Agent({ keepAlive: false }),
    }),
  ],
  providers: [ProzorroService],
  exports: [ProzorroService],
})
export class ProzorroModule {}
