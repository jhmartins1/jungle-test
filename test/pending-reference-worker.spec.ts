
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { PendingReferenceWorkerService } from '../src/modules/wagering/application/pending-reference-worker.service.js';
import { PendingReferenceProcessorService } from '../src/modules/wagering/application/pending-reference-processor.service.js';

describe('PendingReferenceWorkerService', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalEnabled =
        process.env.PENDING_REFERENCE_WORKER_ENABLED;
    const originalInterval =
        process.env.PENDING_REFERENCE_INTERVAL_MS;

    const createWorker = (
        processPending: () => Promise<void>,
    ) => {
        const processor = {
            processPending: vi.fn(processPending),
        };

        const worker = new PendingReferenceWorkerService(
            processor as unknown as PendingReferenceProcessorService,
        );

        return {
            worker,
            processor,
        };
    };

    beforeEach(() => {
        vi.useFakeTimers();

        process.env.NODE_ENV = 'development';
        process.env.PENDING_REFERENCE_WORKER_ENABLED = 'true';
        process.env.PENDING_REFERENCE_INTERVAL_MS = '1000';
    });

    afterEach(() => {
        vi.useRealTimers();

        if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalNodeEnv;
        }

        if (originalEnabled === undefined) {
            delete process.env.PENDING_REFERENCE_WORKER_ENABLED;
        } else {
            process.env.PENDING_REFERENCE_WORKER_ENABLED =
                originalEnabled;
        }

        if (originalInterval === undefined) {
            delete process.env.PENDING_REFERENCE_INTERVAL_MS;
        } else {
            process.env.PENDING_REFERENCE_INTERVAL_MS =
                originalInterval;
        }
    });

    it('automatically executes the processor on each interval', async () => {
        const { worker, processor } = createWorker(
            async () => { },
        );

        worker.onModuleInit();

        await vi.advanceTimersByTimeAsync(1000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            1,
        );

        await vi.advanceTimersByTimeAsync(1000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            2,
        );

        await worker.onModuleDestroy();
    });

    it('prevents overlapping executions', async () => {
        let finishProcessing!: () => void;

        const processingPromise = new Promise<void>(
            (resolve) => {
                finishProcessing = resolve;
            },
        );

        const { worker, processor } = createWorker(
            () => processingPromise,
        );

        worker.onModuleInit();

        await vi.advanceTimersByTimeAsync(1000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            1,
        );

        // O primeiro processamento ainda não terminou.
        await vi.advanceTimersByTimeAsync(3000);

        // Nenhuma nova execução deve começar.
        expect(processor.processPending).toHaveBeenCalledTimes(
            1,
        );

        finishProcessing();
        await Promise.resolve();

        // Após finalizar, o próximo intervalo pode executar.
        await vi.advanceTimersByTimeAsync(1000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            2,
        );

        await worker.onModuleDestroy();
    });

    it('does not start when NODE_ENV is test', async () => {
        process.env.NODE_ENV = 'test';

        const { worker, processor } = createWorker(
            async () => { },
        );

        worker.onModuleInit();

        await vi.advanceTimersByTimeAsync(5000);

        expect(processor.processPending).not.toHaveBeenCalled();

        await worker.onModuleDestroy();
    });

    it('stops scheduling after shutdown', async () => {
        const { worker, processor } = createWorker(
            async () => { },
        );

        worker.onModuleInit();

        await vi.advanceTimersByTimeAsync(1000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            1,
        );

        await worker.onModuleDestroy();

        await vi.advanceTimersByTimeAsync(5000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            1,
        );
    });

    it('waits for an active execution during shutdown', async () => {
        let finishProcessing!: () => void;

        const processingPromise = new Promise<void>(
            (resolve) => {
                finishProcessing = resolve;
            },
        );

        const { worker, processor } = createWorker(
            () => processingPromise,
        );

        worker.onModuleInit();

        await vi.advanceTimersByTimeAsync(1000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            1,
        );

        let shutdownCompleted = false;

        const shutdown = worker.onModuleDestroy().then(() => {
            shutdownCompleted = true;
        });

        await Promise.resolve();

        expect(shutdownCompleted).toBe(false);

        finishProcessing();

        await shutdown;

        expect(shutdownCompleted).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);

        expect(processor.processPending).toHaveBeenCalledTimes(
            1,
        );
    });
});
