
import { Module } from '@nestjs/common';
import { OutboxPublisherService } from './application/outbox-publisher.service.js';

@Module({
    providers: [OutboxPublisherService],
    exports: [OutboxPublisherService],
})
export class OutboxModule { }
