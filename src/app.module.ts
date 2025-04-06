import { AdulType, CategoryType, ChannelType, JobType, TaxType } from '@daechanjo/models';
import { PlaywrightModule, PlaywrightService } from '@daechanjo/playwright';
import { RabbitMQModule } from '@daechanjo/rabbitmq';
import { UtilModule } from '@daechanjo/util';
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
import { DeliveryExtractionProvider } from './core/crawler/provider/deliveryExtraction.provider';
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
      name: 'onch-bull-queue',
      useFactory: async (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>('REDIS_HOST'),
          port: configService.get<number>('REDIS_PORT'),
        },
        prefix: '{bull}',
        defaultJobOptions: {
          removeOnComplete: {
            // 완료된 작업은 하루 후 삭제
            // age: 24 * 60 * 60 * 1000,
            age: 7 * 24 * 60 * 60 * 1000,
            count: 1000,
          },
          removeOnFail: {
            age: 7 * 24 * 60 * 60 * 1000, // 실패한 작업은 일주일 후 삭제
            count: 1000,
          },
          attempts: 100,
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
    PlaywrightModule,
    RabbitMQModule,
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
  ],
})
export class AppModule implements OnApplicationBootstrap, OnModuleInit {
  constructor(
    @InjectQueue('onch-bull-queue') private readonly queue: Queue,
    private readonly playwrightService: PlaywrightService,
    private readonly onchCrawlerService: OnchCrawlerService,
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
