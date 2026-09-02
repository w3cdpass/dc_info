import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreditTemplate } from './entities/credit-template.entity';

@Injectable()
export class CreditService {
  constructor(
    @InjectRepository(CreditTemplate, 'data')
    private readonly repo: Repository<CreditTemplate>,
  ) {}

  async list(): Promise<CreditTemplate[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async create(dto: {
    name: string;
    body: string;
    type?: string;
    creditCost?: number;
    mediaUrl?: string;
    mimetype?: string;
  }): Promise<CreditTemplate> {
    const e = this.repo.create({
      name: dto.name,
      body: dto.body,
      type: dto.type || 'text',
      creditCost: dto.creditCost ?? 1,
      mediaUrl: dto.mediaUrl || null,
      mimetype: dto.mimetype || null,
    });
    return this.repo.save(e);
  }

  async update(id: string, dto: Partial<CreditTemplate>): Promise<CreditTemplate> {
    const e = await this.repo.findOne({ where: { id } });
    if (!e) throw new NotFoundException('Template not found');
    Object.assign(e, dto);
    return this.repo.save(e);
  }

  async remove(id: string): Promise<void> {
    const e = await this.repo.findOne({ where: { id } });
    if (!e) throw new NotFoundException('Template not found');
    await this.repo.remove(e);
  }

  async getCostForType(type: string): Promise<number> {
    const t = await this.repo.findOne({ where: { type } });
    return t?.creditCost ?? (type === 'text' ? 1 : type === 'image' ? 2 : type === 'document' ? 2 : 1);
  }
}
