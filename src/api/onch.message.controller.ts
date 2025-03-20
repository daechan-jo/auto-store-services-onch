import { CronType, RabbitmqMessage } from '@daechanjo/models';
import { InjectQueue } from '@nestjs/bull';
import { Controller, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { Queue } from 'bull';

import { OnchCrawlerService } from '../core/crawler/onch.crawler.service';
import { OnchService } from '../core/onch.service';

@Controller()
export class OnchMessageController implements OnModuleInit, OnModuleDestroy {
  private isEventListenersRegistered = false;

  constructor(
    private readonly onchService: OnchService,
    private readonly onchCrawlerService: OnchCrawlerService,
    @InjectQueue('onch-message-queue') private readonly messageQueue: Queue,
  ) {}

  onModuleInit() {
    this.registerGlobalEvents();
  }

  onModuleDestroy() {
    this.messageQueue.off('global:completed', this.onJobCompleted);
    this.messageQueue.off('global:failed', this.onJobFailed);
  }

  private registerGlobalEvents() {
    if (this.isEventListenersRegistered) return;

    this.messageQueue.on('global:completed', this.onJobCompleted);
    this.messageQueue.on('global:failed', this.onJobFailed);

    this.isEventListenersRegistered = true;
  }

  private onJobCompleted = (jobId: string, result: any) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
    } catch (error: any) {
      console.error(`작업 완료 처리 중 JSON 파싱 실패: ${jobId}`, error.message);
    }
  };

  private onJobFailed = (jobId: string, error: any) => {
    console.error(`작업 실패: ${jobId}`, error);
  };

  @MessagePattern('onch-queue')
  async processMessage(data: RabbitmqMessage) {
    const { pattern, payload } = data;
    console.log(`${payload.type}${payload.cronId}: 📬${pattern}`);

    switch (pattern) {
      case 'clearOnchProducts':
        await this.onchService.clearOnchProducts();
        return { status: 'success' };

      case 'deleteProducts':
        await this.onchCrawlerService.deleteProducts(
          payload.cronId,
          payload.store,
          payload.type,
          payload.matchedCoupangProducts,
          payload.matchedNaverProducts,
        );
        break;

      case 'crawlingOnchSoldoutProducts':
        const { soldoutProductCodes } = await this.onchCrawlerService.crawlingOnchSoldoutProducts(
          payload.store,
          payload.cronId,
          payload.type,
        );
        return { status: 'success', data: { soldoutProductCodes } };

      case 'crawlOnchRegisteredProducts':
        await this.onchCrawlerService.crawlOnchRegisteredProducts(
          payload.cronId,
          payload.store,
          payload.type,
        );
        return { status: 'success' };

      case 'automaticOrdering':
        const automaticOrderingResult = await this.onchCrawlerService.automaticOrdering(
          payload.cronId,
          payload.store,
          payload.newOrderProducts,
          payload.type,
        );
        return { status: 'success', data: automaticOrderingResult };

      case 'deliveryExtraction':
        const waybillExtractionResult = await this.onchCrawlerService.deliveryExtraction(
          payload.cronId,
          payload.store,
          payload.type,
        );
        return { status: 'success', data: waybillExtractionResult };

      default:
        console.error(
          `${CronType.ERROR}${payload.type}${payload.cronId}: 📬알 수 없는 패턴 유형 ${pattern}`,
        );
        return { status: 'error', message: `알 수 없는 패턴 유형: ${pattern}` };
    }
  }
}
