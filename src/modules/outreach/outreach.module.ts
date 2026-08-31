import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutreachCampaign } from './entities/outreach-campaign.entity';
import { OutreachService } from './outreach.service';
import { OutreachController } from './outreach.controller';
import { SessionModule } from '../session/session.module';
import { MessageModule } from '../message/message.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutreachCampaign], 'data'),
    SessionModule,
    MessageModule,
  ],
  controllers: [OutreachController],
  providers: [OutreachService],
  exports: [OutreachService],
})
export class OutreachModule {}
