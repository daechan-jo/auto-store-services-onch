import { JobType, ProductRegistrationResult, RabbitmqMessage } from '@daechanjo/models';
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
    @InjectQueue('onch-bull-queue') private readonly onchBullQueue: Queue,
  ) {}

  onModuleInit() {
    this.registerGlobalEvents();
  }

  onModuleDestroy() {
    this.onchBullQueue.off('global:completed', this.onJobCompleted);
    this.onchBullQueue.off('global:failed', this.onJobFailed);
  }

  private registerGlobalEvents() {
    if (this.isEventListenersRegistered) return;

    this.onchBullQueue.on('global:completed', this.onJobCompleted);
    this.onchBullQueue.on('global:failed', this.onJobFailed);

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
  async processMessage(message: RabbitmqMessage) {
    const { pattern, payload } = message;
    console.log(`${payload.jobType}${payload.jobId}: 📬${pattern}`);

    switch (pattern) {
      case 'clearOnchProducts':
        await this.onchService.clearOnchProducts();
        return { status: 'success' };

      case 'deleteProducts':
        await this.onchCrawlerService.deleteProducts(
          payload.jobId,
          payload.jobType,
          payload.store,
          payload.data,
        );
        break;

      case 'crawlingOnchSoldoutProducts':
        const { soldoutProductCodes } = await this.onchCrawlerService.crawlingOnchSoldoutProducts(
          payload.jobId,
          payload.jobType,
          payload.store,
        );
        return { status: 'success', data: { soldoutProductCodes } };

      case 'crawlOnchRegisteredProducts':
        await this.onchCrawlerService.crawlOnchRegisteredProducts(
          payload.jobId,
          payload.jobType,
          payload.store,
        );
        return { status: 'success' };

      case 'automaticOrdering':
        const automaticOrderingResult = await this.onchCrawlerService.automaticOrdering(
          payload.jobId,
          payload.jobType,
          payload.store,
          payload.data,
        );
        return { status: 'success', data: automaticOrderingResult };

      case 'deliveryExtraction':
        const waybillExtractionResult = await this.onchCrawlerService.deliveryExtraction(
          payload.jobId,
          payload.jobType,
          payload.store,
        );
        return { status: 'success', data: waybillExtractionResult };

      case 'getProductByCode':
        const product = await this.onchService.getProductByCode(payload.data);
        return { status: 'success', data: product };

      case 'productRegistration':
        const job = await this.onchBullQueue.add('product-registration', message);
        const results: ProductRegistrationResult[] = await job.finished();
        return { status: 'success', data: results };

      // queue 관련
      case 'getStatus':
        const status = await this.onchService.getJobStatusCount();
        return { status: 'success', data: status };

      case 'getWaitingJobs':
        const waitingJobs = await this.onchService.getWaitingJobs();
        return { status: 'success', data: waitingJobs };

      case 'getActiveJobs':
        const activeJobs = await this.onchService.getActiveJobs();
        return { status: 'success', data: activeJobs };

      case 'getCompletedJobs':
        const completedJobs = await this.onchService.getCompletedJobs();
        return { status: 'success', data: completedJobs };

      case 'getFailedJobs':
        const failedJobs = await this.onchService.getFailedJobs();
        return { status: 'success', data: failedJobs };

      case 'getDelayedJobs':
        const delayedJobs = await this.onchService.getDelayedJobs();
        return { status: 'success', data: delayedJobs };

      case 'getAllJobs':
        const allJobs = await this.onchService.getAllJobStatus();
        return { status: 'success', data: allJobs };

      case 'deleteJob':
        await this.onchService.removeJob(payload.data);
        return { status: 'success' };

      default:
        console.error(
          `${JobType.ERROR}${payload.jobType}${payload.jobId}: 📬알 수 없는 패턴 유형 ${pattern}`,
        );
        return { status: 'error', message: `알 수 없는 패턴 유형: ${pattern}` };
    }
  }
}
