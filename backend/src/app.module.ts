import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChainModule } from './chain/chain.module.js';
import { type Env, validateEnv } from './config/env.js';
import { dataSourceOptions } from './database/data-source.options.js';
import { HealthController } from './health/health.controller.js';
import { OutboxModule } from './outbox/outbox.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        ...dataSourceOptions(config.get('DATABASE_URL', { infer: true })),
        autoLoadEntities: true,
        migrationsRun: true,
      }),
    }),
    ChainModule,
    OutboxModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
