
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';

import { PendingReferenceProcessorService } from './pending-reference-processor.service.js';

@Injectable()
export class PendingReferenceWorkerService
    implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(
        PendingReferenceWorkerService.name,
    );

    private readonly intervalMs: number;
    private readonly enabled: boolean;

    private timer?: ReturnType<typeof setInterval>;
    private running = false;
    private shuttingDown = false;
    private currentRun?: Promise<void>;

    constructor(
        private readonly processor: PendingReferenceProcessorService,
    ) {
        const configuredInterval = Number(
            process.env.PENDING_REFERENCE_INTERVAL_MS ??
            '10000',
        );

        if (
            !Number.isSafeInteger(configuredInterval) ||
            configuredInterval < 1000 ||
            configuredInterval > 2147483647
        ) {
            throw new Error(
                'PENDING_REFERENCE_INTERVAL_MS must be an integer between 1000 and 2147483647',
            );
        }

        this.intervalMs = configuredInterval;

        // Ativação explícita para evitar execução
        // acidental em ambientes não configurados.
        this.enabled =
            process.env.NODE_ENV !== 'test' &&
            process.env.PENDING_REFERENCE_WORKER_ENABLED ===
            'true';
    }

    onModuleInit(): void {
        if (!this.enabled) {
            this.logger.log(
                'Pending reference worker is disabled',
            );
            return;
        }

        this.logger.log(
            `Pending reference worker started (interval: ${this.intervalMs}ms)`,
        );

        this.timer = setInterval(() => {
            void this.runOnce();
        }, this.intervalMs);
    }

    private runOnce(): Promise<void> {
        if (this.running || this.shuttingDown) {
            return this.currentRun ?? Promise.resolve();
        }

        this.running = true;

        const run = (async () => {
            try {
                await this.processor.processPending();
            } catch (error) {
                this.logger.error(
                    'Pending reference processing failed',
                    error instanceof Error
                        ? error.stack
                        : String(error),
                );
            } finally {
                this.running = false;
            }
        })();

        this.currentRun = run;

        void run.finally(() => {
            if (this.currentRun === run) {
                this.currentRun = undefined;
            }
        });

        return run;
    }

    async onModuleDestroy(): Promise<void> {
        this.shuttingDown = true;

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        if (this.currentRun) {
            this.logger.log(
                'Waiting for pending reference processing to finish',
            );

            await this.currentRun;
        }

        if (this.enabled) {
            this.logger.log(
                'Pending reference worker stopped',
            );
        }
    }
}
