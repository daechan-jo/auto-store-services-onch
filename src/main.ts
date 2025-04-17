import * as process from 'node:process';

import { setupGlobalConsoleLogging } from '@daechanjo/log';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as dotenv from 'dotenv';
import { initializeTransactionalContext } from 'typeorm-transactional';

import { AppModule } from './app.module';
import { AppConfig } from './config/app.config';
import { ValidationPipe } from '@nestjs/common';

const isDev = process.env.NODE_ENV !== 'PROD';

if (isDev) {
  dotenv.config({
    path: '/Users/daechanjo/codes/project/auto-store/.env',
  });
} else {
  dotenv.config();
}

async function bootstrap() {
  const appConfig = AppConfig.getInstance();
  appConfig.appName = 'Onch';

  initializeTransactionalContext();
  setupGlobalConsoleLogging({ appName: appConfig.appName });

  const app = await NestFactory.create(AppModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [isDev ? String(process.env.RABBITMQ_URL) : String(process.env.K8S_RABBITMQ_URL)],
      queue: 'onch-queue',
      queueOptions: { durable: false },
    },
  });

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      validateCustomDecorators: false,
      skipMissingProperties: true,
      whitelist: true,
    }),
  );
  app.setGlobalPrefix('/api');
  const server = app.getHttpAdapter().getInstance();

  server.get('/health', (req: any, res: any) => {
    res.status(200).send('OK');
  });

  // const document = SwaggerModule.createDocument(app, swaggerConfig);
  // SwaggerModule.setup('api/docs', app, document);

  await app.startAllMicroservices();
  await app.listen(9002, '0.0.0.0');
  console.log('온채널 서비스 시작');
}

bootstrap();
