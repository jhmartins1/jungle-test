
import { Module } from '@nestjs/common';
import { OutboxPublisherService } from './application/outbox-publisher.service.js';
import { SqsPublisherService } from './infrastructure/sqs-publisher.service.js';

@Module({
    providers: [OutboxPublisherService, SqsPublisherService],
    exports: [OutboxPublisherService],
})
export class OutboxModule { }
