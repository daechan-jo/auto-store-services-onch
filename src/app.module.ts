import { CommonModule } from '@daechanjo/common-utils';
import { PlaywrightModule, PlaywrightService } from '@daechanjo/playwright';
import { RabbitMQModule } from '@daechanjo/rabbitmq';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bull';

import { OnchMessageController } from './api/onch.message.controller';
import { TypeormConfig } from './config/typeorm.config';
import { OnchCrawlerService } from './core/crawler/onch.crawler.service';
import { AutomaticOrderingProvider } from './core/crawler/provider/automaticOrdering.provider';
import { CrawlingOnchSoldoutProductsProvider } from './core/crawler/provider/crawlingOnchSoldoutProducts.provider';
import { CrawlOnchDetailProductsProvider } from './core/crawler/provider/crawlOnchDetailProducts.provider';
import { CrawlOnchRegisteredProductsProvider } from './core/crawler/provider/crawlOnchRegisteredProducts.provider';
import { DeleteProductsProvider } from './core/crawler/provider/deleteProducts.provider';
import { WaybillExtractionProvider } from './core/crawler/provider/waybillExtraction.provider';
import { MessageQueueProcessor } from './core/onch.queue.processor';
import { OnchService } from './core/onch.service';
import { OnchItemEntity } from './infrastructure/entities/onchItem.entity';
import { OnchProductEntity } from './infrastructure/entities/onchProduct.entity';
import { OnchRepository } from './infrastructure/repository/onch.repository';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '/Users/daechanjo/codes/project/auto-store/.env',
    }),
    TypeOrmModule.forRootAsync(TypeormConfig),
    TypeOrmModule.forFeature([OnchProductEntity, OnchItemEntity]),
    BullModule.registerQueueAsync({
      name: 'onch-message-queue',
      useFactory: async (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>('REDIS_HOST'),
          port: configService.get<number>('REDIS_PORT'),
        },
        prefix: '{bull}',
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: 30000,
        },
        limiter: {
          max: 1,
          duration: 1000,
        },
      }),
      inject: [ConfigService],
    }),
    PlaywrightModule,
    RabbitMQModule,
    CommonModule,
  ],
  controllers: [OnchMessageController],
  providers: [
    OnchService,
    OnchCrawlerService,
    OnchRepository,
    MessageQueueProcessor,
    DeleteProductsProvider,
    CrawlingOnchSoldoutProductsProvider,
    CrawlOnchRegisteredProductsProvider,
    CrawlOnchDetailProductsProvider,
    AutomaticOrderingProvider,
    WaybillExtractionProvider,
  ],
})
export class AppModule implements OnApplicationBootstrap, OnModuleInit {
  constructor(
    @InjectQueue('onch-message-queue') private readonly queue: Queue,
    private readonly playwrightService: PlaywrightService,
  ) {}

  async onModuleInit() {
    await this.queue.clean(0, 'delayed'); // 지연된 작업 제거
    await this.queue.clean(0, 'wait'); // 대기 중인 작업 제거
    await this.queue.clean(0, 'active'); // 활성 작업 제거
    await this.queue.empty(); // 모든 대기 중인 작업 제거 (옵션)
    console.log('Bull 대기열 초기화');
  }

  async onApplicationBootstrap() {
    setTimeout(async () => {
      this.playwrightService.setConfig(true, 'chromium');
      await this.playwrightService.initializeBrowser();
    });
  }
}
