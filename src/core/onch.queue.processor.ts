import { Process, Processor } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';

import { OnchCrawlerService } from './crawler/onch.crawler.service';
import { Job } from 'bull';
import { ConfigService } from '@nestjs/config';

@Processor('onch-bull-queue')
@Injectable()
export class MessageQueueProcessor {
  constructor(
    private readonly configService: ConfigService,
    private readonly onchCrawlerService: OnchCrawlerService,
  ) {}

  @Process({ name: 'product-registration', concurrency: 1 }) // 작업 이름
  async productRegistration(job: Job) {
    const { pattern, payload } = job.data;
    try {
      console.log(`${payload.jobType}${payload.jobId}: 🔥${pattern} - 작업 시작`);

      return await this.onchCrawlerService.productRegistration(
        payload.jobId,
        payload.jobType,
        payload.store,
        payload.data,
      );
    } catch (error: any) {
      console.error(`${payload.jobType}${payload.jobId}: 작업 처리 중 오류 발생`, error);
      throw error;
    } finally {
    }
  }
}
