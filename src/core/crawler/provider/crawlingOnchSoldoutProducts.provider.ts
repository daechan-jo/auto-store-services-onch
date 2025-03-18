import { PlaywrightService } from '@daechanjo/playwright';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

@Injectable()
export class CrawlingOnchSoldoutProductsProvider {
  constructor(private readonly playwrightService: PlaywrightService) {}

  /**
   * 온채널 관리자 사이트에 로그인하고 품절 상품 목록 페이지로 이동합니다.
   *
   * @param store - 접속할 스토어 이름
   * @param contextId - Playwright 컨텍스트 ID
   * @param pageId - Playwright 페이지 ID
   * @returns {Promise<Page>} - 페이지 객체
   *
   * @description
   * - PlaywrightService를 사용하여 온채널 관리자 사이트에 로그인
   * - 상품 목록 페이지(품절 상품 조회 페이지)로 이동
   * - 페이지 로드 시간이 긴 경우를 고려하여 60초 타임아웃 설정
   */
  async navigateToSoldOutProductsPage(
    store: string,
    contextId: string,
    pageId: string,
  ): Promise<Page> {
    // 온채널 사이트 로그인
    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);

    // 품절 상품 목록 페이지로 이동
    await onchPage.goto(
      'https://www.onch3.co.kr/admin_mem_clo_list_2.php?ost=&sec=clo&ol=&npage=',
      {
        timeout: 60000, // 페이지 로드 타임아웃 60초
      },
    );

    return onchPage;
  }

  /**
   * 품절 상품 페이지에서 상품 코드와 등록/수정 날짜를 추출합니다.
   *
   * @param page - Playwright 페이지 객체
   * @param lastCronTime - 마지막 크론 작업 실행 시간 (Date 객체)
   * @returns {Promise<{ stockProductCodes: string[]; productDates: string[] }>} -
   *          품절된 상품 코드 배열과 해당 상품들의 등록/수정 날짜 배열
   *
   * @description
   * - Playwright의 evaluate 메서드를 사용하여 페이지 내 DOM 요소에서 데이터 추출
   * - 마지막 크론 실행 시간 이후에 추가/수정된 품절 상품만 필터링
   * - 날짜 정보는 ISO 문자열 형식으로 변환하여 반환
   */
  async extractSoldOutProducts(
    page: Page,
    lastCronTime: Date | null,
  ): Promise<{ stockProductCodes: string[]; productDates: string[] }> {
    const lastCronTimeMillis = lastCronTime ? lastCronTime.getTime() : 0;

    return page.evaluate((lastCronTimeMillis) => {
      const stockProductCodes: string[] = [];
      const productDates: string[] = [];

      // 테이블의 모든 행 선택
      const rows = Array.from(document.querySelectorAll('tr'));

      // 각 행에서 필요한 데이터 추출
      rows.forEach((row) => {
        const dateCell = row.querySelector('td.title_4.sub_title');
        const codeCell = row.querySelector('td.title_3.sub_title > b');

        if (dateCell && codeCell) {
          const dateText = dateCell.textContent?.trim() || '';
          const codeText = codeCell.textContent?.trim() || '';

          // 날짜 파싱 (형식: '2023-01-01 14:30:00')
          const productDate = new Date(dateText.slice(0, 10) + 'T' + dateText.slice(11));

          // 유효한 날짜인 경우만 처리
          if (!isNaN(productDate.getTime())) {
            productDates.push(productDate.toISOString());

            // 마지막 크론 시간 이후에 추가/수정된, 즉 신규 품절된 상품만 필터링
            if (lastCronTimeMillis && productDate.getTime() > lastCronTimeMillis) {
              stockProductCodes.push(codeText);
            }
          }
        }
      });

      return { stockProductCodes, productDates };
    }, lastCronTimeMillis);
  }
}
