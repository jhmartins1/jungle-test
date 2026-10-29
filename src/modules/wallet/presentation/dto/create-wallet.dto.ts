
import {
    IsUUID,
    IsString,
    IsOptional,
    Matches,
} from 'class-validator';

export class CreateWalletDto {
    @IsUUID()
    playerId!: string;

    @IsString()
    @Matches(/^[A-Z]{3}$/)
    currency!: string;

    @IsOptional()
    @IsString()
    @Matches(/^\d+(\.\d{1,2})?$/)
    initialBalance?: string;
}
