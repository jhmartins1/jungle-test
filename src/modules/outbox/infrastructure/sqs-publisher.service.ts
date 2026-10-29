
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
    SQSClient,
    SendMessageCommand,
} from '@aws-sdk/client-sqs';

@Injectable()
export class SqsPublisherService implements OnModuleDestroy {
    private readonly sqs = new SQSClient({
        region: process.env.AWS_REGION ?? 'us-east-1',
        endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        },
    });

    private readonly queueUrl =
        process.env.SQS_QUEUE_URL ??
        'http://localhost:4566/000000000000/wager-transactions';

    async publish(message: Record<string, unknown>): Promise<void> {
        await this.sqs.send(
            new SendMessageCommand({
                QueueUrl: this.queueUrl,
                MessageBody: JSON.stringify(message),
            }),
        );
    }

    onModuleDestroy() {
        this.sqs.destroy();
    }
}
