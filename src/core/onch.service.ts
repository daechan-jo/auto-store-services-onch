import { Injectable } from '@nestjs/common';

import { OnchRepository } from '../infrastructure/repository/onch.repository';
import Bull, { Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import {
  JobType,
  OnchActiveJob,
  OnchCompletedJob,
  OnchDelayedJob,
  OnchFailedJob,
  OnchJobStatus,
  OnchWaitingJob,
} from '@daechanjo/models';
import { Cron } from '@nestjs/schedule';
import { UtilService } from '@daechanjo/util';
import { OnchCrawlerService } from './crawler/onch.crawler.service';
import { ConfigService } from '@nestjs/config';
import { RabbitMQService } from '@daechanjo/rabbitmq';

@Injectable()
export class OnchService {
  constructor(
    private readonly onchRepository: OnchRepository,
    private readonly utilService: UtilService,
    private readonly configService: ConfigService,
    private readonly rabbitmqService: RabbitMQService,
    private readonly onchCrawlerService: OnchCrawlerService,
    @InjectQueue('onch-bull-queue') private readonly onchBullQueue: Queue,
  ) {}

  async clearOnchProducts() {
    await this.onchRepository.clearOnchProducts();
  }

  async getProductByCode(productCode: string) {
    return this.onchRepository.getProductByCode(productCode);
  }

  /**
   * 큐의 상태 정보를 가져오는 메서드
   */
  async getJobStatusCount(): Promise<{ name: string; counts: Bull.JobCounts }> {
    const counts = await this.onchBullQueue.getJobCounts();
    return {
      name: this.onchBullQueue.name,
      counts,
    };
  }

  /**
   * 대기 중인 작업 목록 조회
   */
  async getWaitingJobs(limit = 10): Promise<OnchWaitingJob[]> {
    const jobs = await this.onchBullQueue.getJobs(['waiting'], 0, limit);
    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      timestamp: job.timestamp,
      attemptsMade: job.attemptsMade,
    }));
  }

  /**
   * 활성(진행 중인) 작업 목록 조회
   */
  async getActiveJobs(): Promise<OnchActiveJob[]> {
    const jobs = await this.onchBullQueue.getJobs(['active']);
    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      timestamp: job.timestamp,
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
    }));
  }

  /**
   * 완료된 작업 목록 조회 (최근 n개)
   */
  async getCompletedJobs(limit = 10): Promise<OnchCompletedJob[]> {
    const jobs = await this.onchBullQueue.getJobs(['completed'], 0, limit);
    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      returnvalue: job.returnvalue,
    }));
  }

  /**
   * 실패한 작업 목록 조회
   */
  async getFailedJobs(limit = 10): Promise<OnchFailedJob[]> {
    const jobs = await this.onchBullQueue.getJobs(['failed'], 0, limit);
    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      timestamp: job.timestamp,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
    }));
  }

  /**
   * 지연된 작업 목록 조회
   */
  async getDelayedJobs(limit = 10): Promise<OnchDelayedJob[]> {
    const jobs = await this.onchBullQueue.getJobs(['delayed'], 0, limit);
    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      timestamp: job.timestamp,
      attemptsMade: job.attemptsMade,
      delay: job.opts.delay,
      delayUntil: new Date(job.timestamp + job.opts.delay),
    }));
  }

  /**
   * 모든 작업 상태 조회
   */
  async getAllJobStatus(limit = 10): Promise<OnchJobStatus> {
    return {
      waiting: await this.getWaitingJobs(limit),
      active: await this.getActiveJobs(),
      completed: await this.getCompletedJobs(limit),
      failed: await this.getFailedJobs(limit),
      delayed: await this.getDelayedJobs(limit),
    };
  }

  /**
   * 작업 제거 메서드
   */
  async removeJob(jobId: string): Promise<void> {
    const job = await this.onchBullQueue.getJob(jobId);
    if (job) {
      await job.remove();

      if (await job.isActive()) {
        await job.discard();
      }
    }
  }

  /**
   * 작업 추가 메서드 (테스트용)
   */
  async addJob(name: string, data: any, opts?: any): Promise<any> {
    return this.onchBullQueue.add(name, data, opts);
  }

  /**
   * 작업 재시도 메서드
   */
  async retryJob(jobId: string): Promise<void> {
    const job = await this.onchBullQueue.getJob(jobId);
    if (job) {
      await job.retry();
    }
  }

  @Cron('0 */10 * * * *')
  async requestNotification() {
    const jobId = this.utilService.generateCronId();
    const jobType = JobType.NOTI;
    const store = this.configService.get<string>('STORE');

    try {
      const isNoti = await this.onchCrawlerService.requestNotification(jobId, store);

      if (isNoti) {
        await this.rabbitmqService.emit('mail-queue', 'sendNotification', {
          jobId,
          jobType,
          jobName: '온채널 신규 메시지 안내',
          data: {
            title: 'ON채널 요청함 확인 요망',
            message: '확인하지 않은 새로운 요청이 있습니다.',
          },
        });
      }
    } catch (error: any) {
      console.error(`${JobType.ERROR}${jobType}${jobId}: 알림 추출중 에러 발생\n`, error);
    }
  }
}
