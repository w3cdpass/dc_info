import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { ResellerUser } from './entities/reseller-user.entity';
import { AuthService } from './auth.service';
import { ResellerService } from './reseller.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { AdminAuthController } from './admin-auth.controller';
import { ResellerController } from './reseller.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, ResellerUser], 'main')],
  controllers: [AuthController, AuthValidateController, AdminAuthController, ResellerController],
  providers: [
    AuthService,
    ResellerService,
    ApiKeyUsageTracker,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService, ResellerService],
})
export class AuthModule {}
