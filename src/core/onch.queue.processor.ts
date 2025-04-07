import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';

import { OnchCrawlerService } from './crawler/onch.crawler.service';
import { Job, Queue } from 'bull';
import {
  OnchProductRegistrationCount,
  ProductRegistrationReqResDto,
  ProductRegistrationResult,
} from '@daechanjo/models';

@Processor('onch-bull-queue')
@Injectable()
export class MessageQueueProcessor {
  constructor(
    private readonly onchCrawlerService: OnchCrawlerService,
    @InjectQueue('onch-bull-queue') private readonly onchBullQueue: Queue,
  ) {}

  @Process({ name: 'product-registration', concurrency: 1 }) // 작업 이름
  async productRegistration(job: Job) {
    const { id, pattern, payload } = job.data;
    try {
      console.log(`${payload.jobType}${payload.jobId}: 🔥${pattern} - 작업 시작`);

      const results: ProductRegistrationResult[] =
        await this.onchCrawlerService.productRegistration(
          payload.jobId,
          payload.jobType,
          payload.store,
          payload.data,
        );

      const summary: OnchProductRegistrationCount = {
        successCount: 0,
        failCount: 0,
        alreadyRegisteredCount: 0,
        duplicateNameCount: 0,
        totalProcessed: 0,
      };

      results.forEach((result) => {
        if (result.success && result.alertMessage) {
          const counts: ProductRegistrationReqResDto = this.extractRegistrationCounts(
            result.alertMessage,
          );

          summary.successCount += counts.successCount;
          summary.failCount += counts.failCount;
          summary.alreadyRegisteredCount += counts.alreadyRegisteredCount;
          summary.duplicateNameCount += counts.duplicateNameCount;
          summary.totalProcessed += counts.totalProcessed;
        }
      });

      const job: Job = await this.onchBullQueue.getJob(id);
      if (job) {
        await job.update({
          ...job.data,
          summary,
        });
      }
    } catch (error: any) {
      console.error(`${payload.jobType}${payload.jobId}: 작업 처리 중 오류 발생`, error);
      throw error;
    } finally {
    }
  }

  private extractRegistrationCounts(alertMessage: string) {
    // 정규표현식으로 카운트 숫자 추출
    const successMatch = alertMessage.match(/성공 : (\d+)/);
    const failMatch = alertMessage.match(/실패 : (\d+)/);
    const alreadyRegisteredMatch = alertMessage.match(/이미 등록된 상품 : (\d+)/);
    const duplicateNameMatch = alertMessage.match(/동일한 상품명 : (\d+)/);

    // 추출된 숫자 변환, 없으면 0으로 설정
    const successCount = successMatch ? parseInt(successMatch[1], 10) : 0;
    const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;
    const alreadyRegisteredCount = alreadyRegisteredMatch
      ? parseInt(alreadyRegisteredMatch[1], 10)
      : 0;
    const duplicateNameCount = duplicateNameMatch ? parseInt(duplicateNameMatch[1], 10) : 0;

    // 총 처리된 상품 수 계산
    const totalProcessed = successCount + failCount + alreadyRegisteredCount + duplicateNameCount;

    return {
      successCount,
      failCount,
      alreadyRegisteredCount,
      duplicateNameCount,
      totalProcessed,
    };
  }
}
