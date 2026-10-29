
import {
    Injectable,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID, createHash } from 'node:crypto';

import { Money } from '../../../../shared/domain/value-objects/money.js';
import { WalletEntity } from '../../infrastructure/persistence/wallet.entity.js';
import {
    WagerTransactionEntity,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../../wagering/infrastructure/persistence/wager-transaction.entity.js';
import {
    WalletLedgerEntryEntity,
    LedgerDirection,
} from '../../infrastructure/persistence/wallet-ledger-entry.entity.js';
import { CreateWalletDto } from '../../presentation/dto/create-wallet.dto.js';

@Injectable()
export class CreateWalletUseCase {
    constructor(private readonly orm: MikroORM) { }

    async execute(dto: CreateWalletDto) {
        let initialBalance: Money;

        try {
            initialBalance = new Money(dto.initialBalance ?? '0.00');
        } catch {
            throw new BadRequestException('Invalid initial balance');
        }

        if (initialBalance.isNegative()) {
            throw new BadRequestException(
                'Initial balance cannot be negative',
            );
        }

        const balance = initialBalance.toString();

        try {
            return await this.orm.em.transactional(async (em) => {
                // 1. Criar a carteira
                const wallet = em.create(WalletEntity, {
                    playerId: dto.playerId,
                    currency: dto.currency,
                    balance,
                    version: 1,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                em.persist(wallet);

                // Garante que a carteira exista no banco
                // antes de inserir registros relacionados.
                await em.flush();

                if (!initialBalance.isZero()) {
                    const transactionId = randomUUID();

                    const payloadHash = createHash('sha256')
                        .update(
                            JSON.stringify({
                                playerId: dto.playerId,
                                currency: dto.currency,
                                initialBalance: balance,
                            }),
                        )
                        .digest('hex');

                    // 2. Criar a transação OPENING
                    const transaction = em.create(
                        WagerTransactionEntity,
                        {
                            id: transactionId,
                            providerId: 'SYSTEM',
                            externalTransactionId: randomUUID(),
                            idempotencyKey: randomUUID(),
                            payloadHash,
                            walletId: wallet.id,
                            playerId: dto.playerId,
                            roundId: 'OPENING',
                            gameId: 'SYSTEM',
                            kind: WagerTransactionKind.OPENING,
                            status: WagerTransactionStatus.PROCESSED,
                            amount: balance,
                            currency: dto.currency,
                            processedAt: new Date(),
                            createdAt: new Date(),
                        },
                    );

                    em.persist(transaction);

                    // Garante que a transação exista antes do ledger.
                    await em.flush();

                    // 3. Registrar crédito no ledger
                    const ledger = em.create(
                        WalletLedgerEntryEntity,
                        {
                            walletId: wallet.id,
                            transactionId: transaction.id,
                            direction: LedgerDirection.CREDIT,
                            amount: balance,
                            currency: dto.currency,
                            balanceBefore: '0.00',
                            balanceAfter: balance,
                            createdAt: new Date(),
                        },
                    );

                    em.persist(ledger);

                    await em.flush();
                }

                return {
                    id: wallet.id,
                    playerId: wallet.playerId,
                    currency: wallet.currency,
                    balance: wallet.balance,
                    version: wallet.version,
                };
            });
        } catch (error) {
            console.error('ERRO AO CRIAR WALLET:', error);

            if (
                error instanceof Error &&
                (error as Error & { code?: string }).code === '23505'
            ) {
                throw new ConflictException(
                    'Wallet already exists for this player and currency',
                );
            }

            throw error;
        }
    }
}
