
import {
    IsEnum,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
} from 'class-validator';

export enum WagerOperation {
    BET = 'BET',
    WIN = 'WIN',
    LOSS = 'LOSS',
    REFUND = 'REFUND',
    ROLLBACK = 'ROLLBACK',
}

export class CreateWagerTransactionDto {
    @IsString()
    providerId!: string;

    @IsString()
    externalTransactionId!: string;

    @IsUUID()
    walletId!: string;

    @IsUUID()
    playerId!: string;

    @IsString()
    roundId!: string;

    @IsString()
    gameId!: string;

    @IsEnum(WagerOperation)
    kind!: WagerOperation;

    @Matches(/^(0|[1-9]\d*)\.\d{2}$/)
    amount!: string;

    @Matches(/^[A-Z]{3}$/)
    currency!: string;

    @IsOptional()
    @IsString()
    referenceExternalTransactionId?: string;
}
