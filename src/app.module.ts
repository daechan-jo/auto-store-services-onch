import { PlaywrightModule, PlaywrightService } from '@daechanjo/playwright';
import { RabbitMQModule } from '@daechanjo/rabbitmq';
import { UtilModule } from '@daechanjo/util';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { ScheduleModule } from '@nestjs/schedule';

import { OnchMessageController } from './api/onch.message.controller';
import { TypeormConfig } from './config/typeorm.config';
import { OnchCrawlerService } from './core/crawler/onch.crawler.service';
import { AutomaticOrderingProvider } from './core/crawler/provider/automaticOrdering.provider';
import { CrawlingOnchSoldoutProductsProvider } from './core/crawler/provider/crawlingOnchSoldoutProducts.provider';
import { CrawlOnchDetailProductsProvider } from './core/crawler/provider/crawlOnchDetailProducts.provider';
import { CrawlOnchRegisteredProductsProvider } from './core/crawler/provider/crawlOnchRegisteredProducts.provider';
import { DeleteProductsProvider } from './core/crawler/provider/deleteProducts.provider';
import { DeliveryExtractionProvider } from './core/crawler/provider/deliveryExtraction.provider';
import { MessageQueueProcessor } from './core/onch.queue.processor';
import { OnchService } from './core/onch.service';
import { OnchItemEntity } from './infrastructure/entities/onchItem.entity';
import { OnchProductEntity } from './infrastructure/entities/onchProduct.entity';
import { OnchRepository } from './infrastructure/repository/onch.repository';
import { RequestNotificationProvider } from './core/crawler/provider/requestNotification.provider';
import { ProductRegistrationProvider } from './core/crawler/provider/productRegistration.provider';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV !== 'PROD'
          ? '/Users/daechanjo/codes/project/auto-store/.env'
          : '/app/.env',
    }),
    TypeOrmModule.forRootAsync(TypeormConfig),
    TypeOrmModule.forFeature([OnchProductEntity, OnchItemEntity]),
    BullModule.registerQueueAsync({
      name: 'onch-bull-queue',
      useFactory: async (configService: ConfigService) => ({
        redis: configService.get<string>('REDIS_URL'),
        prefix: '{bull}',
        defaultJobOptions: {
          removeOnComplete: {
            age: 7 * 24 * 60 * 60 * 1000,
            count: 1000,
          },
          removeOnFail: {
            age: 7 * 24 * 60 * 60 * 1000, // 실패한 작업은 일주일 후 삭제
            count: 1000,
          },
          attempts: 5,
          backoff: {
            type: 'fixed',
            delay: 5000,
          },
        },
        limiter: {
          max: 1,
          duration: 1000,
        },
      }),
      inject: [ConfigService],
    }),
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        urls: [configService.get<string>('RABBITMQ_URL')],
      }),
    }),
    ScheduleModule.forRoot(),
    PlaywrightModule,
    UtilModule,
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
    DeliveryExtractionProvider,
    RequestNotificationProvider,
    ProductRegistrationProvider,
  ],
})
export class AppModule implements OnApplicationBootstrap, OnModuleInit {
  constructor(
    @InjectQueue('onch-bull-queue') private readonly queue: Queue,
    private readonly playwrightService: PlaywrightService,
    private readonly onchCrawlerService: OnchCrawlerService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {}

  async onApplicationBootstrap() {
    await this.queue.clean(0, 'delayed'); // 지연된 작업 제거
    await this.queue.clean(0, 'wait'); // 대기 중인 작업 제거paused
    await this.queue.clean(0, 'active'); // 활성 작업 제거
    await this.queue.clean(0, 'paused'); // 활성 작업 제거
    await this.queue.empty(); // 모든 대기 중인 작업 제거 (옵션)

    setTimeout(async () => {
      this.playwrightService.setConfig(this.configService.get<boolean>('HEAD_LESS'), 'chromium');
      await this.playwrightService.initializeBrowser();
    });
  }
}
