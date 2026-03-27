import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiOperation, ApiResponse, ApiTags, ApiSecurity } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchTendersQueryDto } from './dto/search-tenders-query.dto';
import { SearchContractsQueryDto } from './dto/search-contracts-query.dto';

@ApiTags('search')
@ApiSecurity('api-key')
@Controller('search')
export class SearchController {
    constructor(
        private readonly searchService: SearchService,
    ) { }

    @Get('tenders')
    @ApiOperation({ summary: 'Search tenders with filters' })
    @ApiQuery({ name: 'edrpou', required: false, type: String, description: 'Entity identifier (8 or 10 digits)' })
    @ApiQuery({ name: 'role', required: false, type: String, description: 'Role of identifier. Supports comma-separated values like customer,supplier. Default: customer' })
    @ApiQuery({ name: 'status', required: false, type: String, description: 'Tender status. Supports comma-separated values like active,complete' })
    @ApiQuery({ name: 'year', required: false, type: Number, description: 'Filter by tender year (derived from dateModified), e.g. 2025' })
    @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Filter by dateModified from (ISO format; date-only values start at 00:00:00Z, e.g. 2025-01-01)' })
    @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Filter by dateModified to (ISO format; date-only values include the full day, e.g. 2025-12-31)' })
    @ApiQuery({ name: 'priceFrom', required: false, type: Number, description: 'Minimum amount' })
    @ApiQuery({ name: 'priceTo', required: false, type: Number, description: 'Maximum amount' })
    @ApiQuery({ name: 'dateType', required: false, type: String, description: 'Which date to filter by (e.g. dateModified, dateCreated, tenderPeriodStart). Default: dateModified' })
    @ApiQuery({ name: 'sort', required: false, enum: ['default', 'dateCreatedDesc', 'dateCreatedAsc', 'amountAsc', 'amountDesc'], description: 'Sort tenders by default order, publication date, or amount' })
    @ApiQuery({ name: 'skip', required: false, type: Number, description: 'Number of items to skip (default: 0)' })
    @ApiQuery({ name: 'take', required: false, type: Number, description: 'Number of items to take (default: 20, max: 100)' })
    @ApiResponse({ status: 200, description: 'List of matching tenders with total count' })
    async searchTenders(
        @Query() query: SearchTendersQueryDto,
    ) {
        return this.searchService.searchTenders(query);
    }

    @Get('contracts')
    @ApiOperation({ summary: 'Search contracts with filters' })
    @ApiQuery({ name: 'edrpou', required: false, type: String, description: 'Entity identifier (8 or 10 digits)' })
    @ApiQuery({ name: 'role', required: false, type: String, description: 'Role of identifier. Supports comma-separated values like supplier,customer. Default: supplier' })
    @ApiQuery({ name: 'status', required: false, type: String, description: 'Contract status. Supports comma-separated values like active,terminated' })
    @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Filter by dateSigned from (ISO format; date-only values start at 00:00:00Z, e.g. 2025-01-01)' })
    @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Filter by dateSigned to (ISO format; date-only values include the full day, e.g. 2025-12-31)' })
    @ApiQuery({ name: 'priceFrom', required: false, type: Number, description: 'Minimum amount' })
    @ApiQuery({ name: 'priceTo', required: false, type: Number, description: 'Maximum amount' })
    @ApiQuery({ name: 'dateType', required: false, type: String, description: 'Which date to filter by (dateModified, dateSigned). Default: dateSigned' })
    @ApiQuery({ name: 'sort', required: false, enum: ['default', 'amountAsc', 'amountDesc', 'dateSignedDesc', 'dateSignedAsc'], description: 'Sort contracts by default order, amount, or signed date' })
    @ApiQuery({ name: 'skip', required: false, type: Number, description: 'Number of items to skip (default: 0)' })
    @ApiQuery({ name: 'take', required: false, type: Number, description: 'Number of items to take (default: 20, max: 100)' })
    @ApiResponse({ status: 200, description: 'List of matching contracts with total count' })
    async searchContracts(
        @Query() query: SearchContractsQueryDto,
    ) {
        return this.searchService.searchContracts(query);
    }


    @Get('company/:edrpou')
    @ApiOperation({ summary: 'Get company profile by EDRPOU' })
    @ApiParam({ name: 'edrpou', type: String, description: 'Company EDRPOU (8 or 10 digits)' })
    @ApiResponse({ status: 200, description: 'Company profile with aggregated statistics' })
    @ApiResponse({ status: 404, description: 'Company not found' })
    async getCompanyProfile(@Param('edrpou') edrpou: string) {
        const profile = await this.searchService.getCompanyProfile(edrpou);
        if (!profile) {
            throw new NotFoundException(`Company with EDRPOU ${edrpou} not found`);
        }
        return profile;
    }

    @Get('stats')
    @ApiOperation({ summary: 'Get total stats for tenders and contracts' })
    @ApiResponse({ status: 200, description: 'Total counts' })
    async getStats() {
        return this.searchService.getStats();
    }
}
