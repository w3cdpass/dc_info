import { Injectable, ConflictException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { ResellerUser } from './entities/reseller-user.entity';
import { AuthService } from './auth.service';
import { ApiKeyRole } from './entities/api-key.entity';

@Injectable()
export class ResellerService {
  constructor(
    @InjectRepository(ResellerUser, 'main')
    private readonly userRepo: Repository<ResellerUser>,
    private readonly authService: AuthService,
  ) {}

  async createDemoUser(dto: { email: string; password: string; role?: string; credits?: number; creditCost?: Record<string, number>; name?: string }, actorEmail?: string): Promise<{ user: ResellerUser; rawKey: string }> {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already exists');
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const role = dto.role || 'demo';
    // Only super admin infyle@infyle.com can create admin
    if (role === 'admin' && actorEmail?.toLowerCase() !== 'infyle@infyle.com') {
      throw new ConflictException('Only main admin (infyle@infyle.com) can create admin users');
    }
    const { apiKey, rawKey } = await this.authService.createApiKey({
      name: dto.name || email,
      role: role as any,
      credits: dto.credits,
      creditCost: dto.creditCost,
    } as any);
    const user = this.userRepo.create({
      email,
      passwordHash,
      role,
      apiKeyId: apiKey.id,
      apiKeyRaw: rawKey,
      credits: dto.credits ?? null,
      isActive: true,
    });
    const saved = await this.userRepo.save(user);
    return { user: saved, rawKey };
  }

  async verify(email: string, password: string): Promise<{ user: ResellerUser; rawKey: string } | null> {
    const user = await this.userRepo.findOne({ where: { email: email.toLowerCase().trim(), isActive: true } });
    if (!user) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return null;
    return { user, rawKey: user.apiKeyRaw || '' };
  }

  async list(): Promise<ResellerUser[]> {
    return this.userRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findByEmail(email: string): Promise<ResellerUser | null> {
    return this.userRepo.findOne({ where: { email: email.toLowerCase().trim() } });
  }

  async delete(id: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (user.apiKeyId) {
      try { await this.authService.delete(user.apiKeyId); } catch {}
    }
    await this.userRepo.remove(user);
  }

  // For AdminAuthController fallback
  async verifyResellerCredentials(email: string, password: string): Promise<{ id: string; email: string; role: string } | null> {
    const res = await this.verify(email, password);
    if (!res) return null;
    return { id: res.user.id, email: res.user.email, role: res.user.role };
  }
}
