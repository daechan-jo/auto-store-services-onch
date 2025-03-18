import { CronType } from '@daechanjo/models';
import { InjectQueue } from '@nestjs/bull';
import { Controller, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { Queue } from 'bull';

import { OnchService } from '../core/onch.service';

@Controller()
export class OnchMessageController implements OnModuleInit, OnModuleDestroy {
  private isEventListenersRegistered = false;

  constructor(
    private readonly onchService: OnchService,
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
  async handleOnchMessage(message: any) {
    const { pattern, payload } = message;

    try {
      const queuePatterns = [
        'deleteProducts',
        'crawlingOnchSoldoutProducts',
        'crawlOnchRegisteredProducts',
        'automaticOrdering',
        'waybillExtraction',
        'soldoutCheck',
      ];

      if (queuePatterns.includes(pattern)) {
        console.log(`${payload.type}${payload.cronId}: 📨${pattern}`);
        const job = await this.messageQueue.add('process-message', message);

        if (
          [
            'crawlingOnchSoldoutProducts',
            'crawlOnchRegisteredProducts',
            'automaticOrdering',
            'waybillExtraction',
            'soldoutCheck',
          ].includes(pattern)
        ) {
          // return await job.finished();
          return new Promise((resolve, reject) => {
            const onComplete = (jobId: string, result: any) => {
              if (jobId === job.id) {
                this.messageQueue.off('global:completed', onComplete);
                this.messageQueue.off('global:failed', onFail);
                try {
                  resolve(typeof result === 'string' ? JSON.parse(result) : result); // JSON으로 파싱
                } catch (error: any) {
                  reject(new Error(`JSON 파싱 실패: ${error.message}`));
                }
              }
            };

            const onFail = (jobId: string, error: any) => {
              if (jobId === job.id) {
                this.messageQueue.off('global:completed', onComplete);
                this.messageQueue.off('global:failed', onFail);
                reject(error);
              }
            };

            this.messageQueue.on('global:completed', onComplete);
            this.messageQueue.on('global:failed', onFail);
          });
        }

        return;
      }
      return await this.processMessage(pattern, payload);
    } catch (error: any) {
      console.error(
        `${CronType.ERROR}${payload.type}${payload.cronId}: 📬${pattern}\n`,
        error.response?.data || error.message,
      );
      return { status: 'error', message: error.message };
    }
  }

  async processMessage(pattern: string, payload: any) {
    console.log(`${payload.type}${payload.cronId}: 📬${pattern}`);
    switch (pattern) {
      case 'clearOnchProducts':
        await this.onchService.clearOnchProducts();
        return { status: 'success' };

      default:
        console.error(
          `${CronType.ERROR}${payload.type}${payload.cronId}: 📬알 수 없는 패턴 유형 ${pattern}`,
        );
        return { status: 'error', message: `알 수 없는 패턴 유형: ${pattern}` };
    }
  }
}
