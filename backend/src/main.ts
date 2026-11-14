import { StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('sto-platform API').setVersion('0.1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, document);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
