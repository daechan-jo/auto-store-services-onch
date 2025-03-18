import { CronType } from '@daechanjo/models';
import { Processor, Process } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Job } from 'bull';

import { OnchCrawlerService } from './crawler/onch.crawler.service';

@Processor('onch-message-queue')
@Injectable()
export class MessageQueueProcessor {
  constructor(private readonly onchService: OnchCrawlerService) {}

  @Process({ name: 'process-message', concurrency: 1 })
  async processMessage(job: Job) {
    const { pattern, payload } = job.data;

    console.log(`${payload.type}${payload.cronId}: 🔥${pattern}`);

    try {
      switch (pattern) {
        case 'deleteProducts':
          await this.onchService.deleteProducts(
            payload.cronId,
            payload.store,
            payload.type,
            payload.matchedCoupangProducts,
            payload.matchedNaverProducts,
          );
          break;

        case 'crawlingOnchSoldoutProducts':
          const { stockProductCodes, productDates } =
            await this.onchService.crawlingOnchSoldoutProducts(
              payload.lastCronTime,
              payload.store,
              payload.cronId,
              payload.type,
            );
          return { status: 'success', data: { stockProductCodes, productDates } };

        // todo 현재 price 모듈의 분리환경에서 운영중
        case 'crawlOnchRegisteredProducts':
          await this.onchService.crawlOnchRegisteredProducts(
            payload.cronId,
            payload.store,
            payload.type,
          );
          return { status: 'success' };

        case 'automaticOrdering':
          const automaticOrderingResult = await this.onchService.automaticOrdering(
            payload.cronId,
            payload.store,
            payload.newOrderProducts,
            payload.type,
          );
          return { status: 'success', data: automaticOrderingResult };

        case 'waybillExtraction':
          const waybillExtractionResult = await this.onchService.waybillExtraction(
            payload.cronId,
            payload.store,
            payload.lastCronTime,
            payload.type,
          );
          return { status: 'success', data: waybillExtractionResult };

        default:
          console.warn(
            `${CronType.ERROR}${payload.type}${payload.cronId}: 🔥알 수 없는 패턴 ${pattern}`,
          );
      }
    } catch (error: any) {
      console.error(`${CronType.ERROR}${payload.type}${payload.cronId}: 🔥${pattern}\n`, error);
    }
  }
}
