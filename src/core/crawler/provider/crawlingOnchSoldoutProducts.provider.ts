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
   * @returns {Promise<{ soldoutProductCodes: string[]; }>} -
   *          품절된 상품 코드 배열과 해당 상품들의 등록/수정 날짜 배열
   *
   * @description
   * - Playwright의 evaluate 메서드를 사용하여 페이지 내 DOM 요소에서 데이터 추출
   * - 마지막 크론 실행 시간 이후에 추가/수정된 품절 상품만 필터링
   * - 날짜 정보는 ISO 문자열 형식으로 변환하여 반환
   */
  async extractSoldOutProducts(page: Page): Promise<{ soldoutProductCodes: string[] }> {
    return await page.evaluate(() => {
      const stockProductCodes = [];
      const productDates = [];

      // 상품 정보가 있는 테이블 찾기
      const productRows = Array.from(
        document.querySelectorAll('table tbody tr td.title_3.sub_title'),
      ).filter((td) => td.querySelector('b'));

      // 각 상품 행에서 데이터 추출
      productRows.forEach((cell) => {
        // 코드 추출 (b 태그 안에 있는 코드)
        const codeElement = cell.querySelector('b');
        if (codeElement) {
          const codeText = codeElement.textContent?.trim() || '';
          stockProductCodes.push(codeText);
        }

        // 이 셀과 관련된 날짜 셀 찾기 (같은 행 내의 날짜 셀)
        const row = cell.closest('tr');
        const dateCell = row?.querySelector('td.title_4.sub_title');

        if (dateCell) {
          const dateText = dateCell.textContent?.trim() || '';
          // 날짜 파싱 (형식: '2023-01-01 14:30:00')
          const productDate = new Date(dateText.slice(0, 10) + 'T' + dateText.slice(11));

          // 유효한 날짜인 경우만 처리
          if (!isNaN(productDate.getTime())) {
            productDates.push(productDate.toISOString());
          }
        }
      });

      return {
        soldoutProductCodes: stockProductCodes,
      };
    });
  }
}
