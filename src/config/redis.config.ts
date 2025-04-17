import { RedisModuleOptions } from '@nestjs-modules/ioredis';
import * as process from 'node:process';
import * as dotenv from 'dotenv';

process.env.NODE_ENV !== 'PROD'
  ? dotenv.config({
      path: '/Users/daechanjo/codes/project/auto-store/.env',
    })
  : dotenv.config({
      path: '/app/.env',
    });

export const redisConfig: RedisModuleOptions = {
  type: 'single',
  url: process.env.REDIS_URL,
};
