import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applySearch,
  applySort,
  getPagination,
  QueryDto,
} from 'src/common/query';
import { Repository } from 'typeorm';

import { CreateGamificationParticipationDto } from './dto/create-gamification.dto';
import { GamificationAnswer } from './entities/gamification-answer.entity';
import { GamificationParticipation } from './entities/gamification-participation.entity';

export interface GamificationOptionStat {
  optionNumber: number;
  count: number;
  percentage: number;
  percentageOfParticipants: number;
}

export interface GamificationQuestionStat {
  questionNumber: number;
  totalAnswers: number;
  options: GamificationOptionStat[];
  mostSelectedOption: GamificationOptionStat | null;
}

@Injectable()
export class GamificationService {
  constructor(
    @InjectRepository(GamificationParticipation)
    private readonly participationRepo: Repository<GamificationParticipation>,

    @InjectRepository(GamificationAnswer)
    private readonly answerRepo: Repository<GamificationAnswer>,
  ) {}

  async create(dto: CreateGamificationParticipationDto) {
    const fullName = this.resolveFullName(dto);

    const duplicate = await this.participationRepo.findOne({
      where: { phone: dto.phone },
    });

    if (duplicate) {
      throw new ConflictException(
        'با این شماره موبایل قبلاً در نظرسنجی شرکت کرده‌اید.',
      );
    }

    const answers = this.buildAnswers(dto.answers);

    const participation = this.participationRepo.create({
      fullName,
      phone: dto.phone,
      birthDate: dto.birthDate,
      answers,
    });

    const saved = await this.participationRepo.save(participation);

    return {
      message: 'نظر شما با موفقیت ثبت شد. از همراهی شما سپاسگزاریم.',
      data: saved,
    };
  }

  async findAll(query: QueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.participationRepo
      .createQueryBuilder('participation')
      .leftJoinAndSelect('participation.answers', 'answer');

    applySearch(qb, query.search, [
      'participation.fullName',
      'participation.phone',
    ]);

    if (query.questionNumber || query.optionNumber) {
      const subQuery = this.answerRepo
        .createQueryBuilder('answerFilter')
        .select('answerFilter.participationId');

      if (query.questionNumber) {
        subQuery.andWhere(
          'answerFilter.questionNumber = :filterQuestionNumber',
          {
            filterQuestionNumber: query.questionNumber,
          },
        );
      }

      if (query.optionNumber) {
        subQuery.andWhere('answerFilter.optionNumber = :filterOptionNumber', {
          filterOptionNumber: query.optionNumber,
        });
      }

      qb.andWhere(`participation.id IN (${subQuery.getQuery()})`).setParameters(
        subQuery.getParameters(),
      );
    }

    if (query.sort) {
      applySort(qb, query.sort, 'participation');
    } else {
      qb.orderBy('participation.createdAt', 'DESC').addOrderBy(
        'participation.id',
        'DESC',
      );
    }

    let data: GamificationParticipation[];
    let total: number;

    if (query.all) {
      data = await qb.getMany();
      total = data.length;
    } else {
      const { skip, take } = getPagination(page, limit);
      qb.skip(skip).take(take);

      const [rows, count] = await qb.getManyAndCount();
      data = rows;
      total = count;
    }

    return {
      data: data.map(participation => this.toAdminView(participation)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number) {
    const participation = await this.participationRepo
      .createQueryBuilder('participation')
      .leftJoinAndSelect('participation.answers', 'answer')
      .where('participation.id = :id', { id })
      .getOne();

    if (!participation) {
      throw new NotFoundException('شرکت‌کننده پیدا نشد.');
    }

    return this.toAdminView(participation);
  }

  async remove(id: number) {
    const participation = await this.participationRepo.findOne({
      where: { id },
    });

    if (!participation) {
      throw new NotFoundException('شرکت‌کننده پیدا نشد.');
    }

    await this.participationRepo.remove(participation);

    return {
      message: 'رکورد شرکت‌کننده با موفقیت حذف شد.',
    };
  }

  async getStats(query: QueryDto) {
    const totalParticipations = await this.participationRepo.count();

    const answersQb = this.answerRepo
      .createQueryBuilder('answer')
      .select('answer.questionNumber', 'questionNumber')
      .addSelect('answer.optionNumber', 'optionNumber')
      .addSelect('COUNT(answer.id)', 'count')
      .groupBy('answer.questionNumber')
      .addGroupBy('answer.optionNumber');

    if (query.questionNumber) {
      answersQb.andWhere('answer.questionNumber = :questionNumber', {
        questionNumber: query.questionNumber,
      });
    }

    const rows = await answersQb.getRawMany<{
      questionNumber: string;
      optionNumber: string;
      count: string;
    }>();

    const countsByQuestion = new Map<number, Map<number, number>>();

    for (const row of rows) {
      const questionNumber = Number(row.questionNumber);
      const optionNumber = Number(row.optionNumber);
      const count = Number(row.count);

      if (!countsByQuestion.has(questionNumber)) {
        countsByQuestion.set(questionNumber, new Map<number, number>());
      }

      countsByQuestion.get(questionNumber)!.set(optionNumber, count);
    }

    const questionNumbers = query.questionNumber
      ? [Number(query.questionNumber)]
      : [1, 2, 3, 4];

    const questions = questionNumbers.map(questionNumber => {
      const optionMap =
        countsByQuestion.get(questionNumber) ?? new Map<number, number>();

      const options = [1, 2, 3, 4].map(optionNumber => ({
        optionNumber,
        count: optionMap.get(optionNumber) ?? 0,
      }));

      const totalAnswers = options.reduce(
        (sum, option) => sum + option.count,
        0,
      );

      return {
        questionNumber,
        totalAnswers,
        options,
      };
    });

    const totalAnswers =
      questions.reduce((sum, question) => sum + question.totalAnswers, 0) / 4;

    return {
      message: 'آمار نظرسنجی با موفقیت دریافت شد.',
      data: {
        totalParticipations,
        totalAnswers,
        totalQuestions: questions.length,
        questions,
      },
    };
  }

  private buildAnswers(items: CreateGamificationParticipationDto['answers']) {
    const seenQuestionNumbers = new Set<number>();
    const answers: GamificationAnswer[] = [];

    items.forEach(item => {
      if (seenQuestionNumbers.has(item.questionNumber)) {
        throw new BadRequestException(
          `به سوال ${item.questionNumber} بیش از یک بار پاسخ داده شده است.`,
        );
      }

      seenQuestionNumbers.add(item.questionNumber);

      answers.push(
        this.answerRepo.create({
          questionNumber: item.questionNumber,
          optionNumber: item.optionNumber,
        }),
      );
    });

    if (seenQuestionNumbers.size < 4) {
      throw new BadRequestException(`پاسخ به همه ${4} سوال الزامی است.`);
    }

    return answers;
  }

  private resolveFullName(dto: CreateGamificationParticipationDto): string {
    const fullName =
      dto.fullName?.trim() ||
      [dto.firstName?.trim(), dto.lastName?.trim()]
        .filter(Boolean)
        .join(' ')
        .trim();

    if (!fullName) {
      throw new BadRequestException('نام و نام خانوادگی الزامی است.');
    }

    return fullName;
  }

  private toAdminView(participation: GamificationParticipation) {
    return {
      id: participation.id,
      fullName: participation.fullName,
      phone: participation.phone,
      birthDate: participation.birthDate,
      answers: (participation.answers ?? []).map(answer => ({
        questionNumber: answer.questionNumber,
        optionNumber: answer.optionNumber,
      })),
      answersText: participation.answersText,
      createdAt: participation.createdAt,
    };
  }
}
