import { Controller, Get, SetMetadata } from '@nestjs/common';
import { AppService } from './app.service';
import { IS_PUBLIC_KEY } from './auth/api-key.guard';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @SetMetadata(IS_PUBLIC_KEY, true)
  async getHealth() {
    return this.appService.getHealth();
  }
}
