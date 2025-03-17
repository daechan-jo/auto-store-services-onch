import { PlaywrightService } from '@daechanjo/playwright';
import { Injectable } from '@nestjs/common';

import { CronType } from '../../../../models/types/cron.type';
import { Dialog, CoupangOrderInfo, OnchSoldout } from '../../../../models/interfaces';
import { OnchRepository } from '../infrastructure/repository/onch.repository';
import { OnchProductInterface } from '../../../../models/interfaces/data/onchProduct.interface';
import { Page } from 'playwright';
import { courierNames } from '../common/couries';

@Injectable()
export class OnchCrawlerService {
  constructor(
    private readonly playwrightService: PlaywrightService,
    private readonly onchRepository: OnchRepository,
  ) {}

  async clearOnchProducts() {
    await this.onchRepository.clearOnchProducts();
  }

  /**
   * 쿠팡과 네이버 플랫폼에서 품절된 상품을 온채널에서 삭제하는 메서드
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 삭제 작업을 수행할 스토어 이름
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   * @param matchedCoupangProducts - 쿠팡에서 품절된 상품 목록 배열
   * @param matchedNaverProducts - 네이버에서 품절된 상품 목록 배열 (선택적)
   *
   * @returns {Promise<void>} - 삭제 작업 완료 시 해결되는 Promise
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 쿠팡과 네이버의 품절 상품에서 온채널 상품 코드(CH로 시작하는 코드)를 추출하여 중복 없이 저장
   * 2. 온채널 관리자 사이트에 로그인
   * 3. 대화상자(alert, confirm) 자동 처리를 위한 이벤트 핸들러 등록
   * 4. 상품 코드별로 온채널 관리자 페이지에 접속하여 삭제 버튼 클릭
   * 5. 진행 상황을 10% 단위로 로깅
   * 6. 작업 완료 후 Playwright 페이지 리소스 해제
   */
  async deleteProducts(
    cronId: string,
    store: string,
    type: string,
    matchedCoupangProducts: any[],
    matchedNaverProducts?: any[],
  ): Promise<void> {
    console.log(`${type}${cronId}: 온채널 품절상품 삭제`);
    const pageId = `page-${store}-${cronId}`;
    const contextId = `context-${store}-${cronId}`;

    // 각 상품 코드 추출 및 중복 제거
    const productCodesSet = new Set<string>();
    for (const product of matchedCoupangProducts) {
      const productCode = product.sellerProductName.match(/CH\d{7}/)?.[0];
      if (productCode) {
        productCodesSet.add(productCode);
      }
    }

    if (matchedNaverProducts)
      for (const product of matchedNaverProducts) {
        const productCode = product.sellerManagementCode;
        if (productCode) {
          productCodesSet.add(productCode);
        }
      }
    const productCodesArray = Array.from(productCodesSet);
    const totalProducts = productCodesArray.length;

    if (totalProducts === 0) {
      console.log(`${type}${cronId}: 삭제할 상품이 없습니다.`);
      return;
    }

    console.log(`${type}${cronId}: 총 ${totalProducts}개 상품 삭제 예정`);

    // 병렬 처리를 위한 설정
    const BATCH_SIZE = 2; // 동시에 처리할 최대 페이지 수
    let completedCount = 0;
    let failedCount = 0;

    // 배치 단위로 처리
    for (let i = 0; i < totalProducts; i += BATCH_SIZE) {
      const batchItems = productCodesArray.slice(i, i + BATCH_SIZE);
      const batchPromises = batchItems.map(async (productCode, batchIndex) => {
        const pageId = `page-${store}-${cronId}-${i + batchIndex}`;
        let page = null;

        try {
          // 페이지 생성
          page = await this.playwrightService.createPage(contextId, pageId);

          // 대화상자 처리 핸들러 설정
          page.on('dialog', async (dialog: Dialog) => {
            try {
              console.log(`${type}${cronId}: ${dialog.type()} 대화상자 처리 - ${dialog.message()}`);
              await dialog.accept();
            } catch (error: any) {
              console.error(
                `${CronType.ERROR}${type}${cronId}: 대화상자 처리 실패 - ${error.message}`,
              );
            }
          });

          // 상품 페이지로 이동
          await page.goto(`https://www.onch3.co.kr/admin_mem_prd_list.html?ost=${productCode}`, {
            waitUntil: 'domcontentloaded', // 더 빠른 로드 옵션 사용
          });

          // 삭제 버튼 찾기
          const deleteButton = page.locator('a[onclick^="prd_list_del"]');
          const hasDeleteButton = (await deleteButton.count()) > 0;

          if (hasDeleteButton) {
            // 삭제 버튼 클릭 및 대화상자 처리를 위한 기다림
            await Promise.all([
              // 삭제 버튼 클릭
              deleteButton.click(),
              // 대화상자가 나타날 때까지 대기 (옵션)
              page.waitForEvent('dialog', { timeout: 2000 }).catch(() => {}),
            ]);

            // 대화상자 처리를 위한 최소 대기 시간
            await page.waitForTimeout(300);

            completedCount++;
            console.log(`${type}${cronId}: 상품 "${productCode}" 삭제 완료`);
          } else {
            console.log(`${type}${cronId}: 상품 "${productCode}"에 대한 삭제 버튼을 찾을 수 없음`);
          }
        } catch (error: any) {
          failedCount++;
          console.error(
            `${CronType.ERROR}${type}${cronId}: 상품 "${productCode}" 삭제 중 오류 발생\n`,
            error.message,
          );
        } finally {
          // 페이지 리소스 해제
          if (page) {
            await this.playwrightService.releasePage(pageId);
          }
        }
      });

      // 현재 배치의 모든 작업 완료 대기
      await Promise.all(batchPromises);

      // 진행률 로깅 (각 배치 완료 후)
      const processedCount = Math.min(i + BATCH_SIZE, totalProducts);
      console.log(
        `${type}${cronId}: 진행률 ${processedCount}/${totalProducts} (${Math.round((processedCount / totalProducts) * 100)}%)`,
      );
    }

    // 최종 결과 로깅
    console.log(
      `${type}${cronId}: 상품 삭제 작업 완료. 성공: ${completedCount}, 실패: ${failedCount}`,
    );

    // 컨텍스트 리소스 해제
    await this.playwrightService.releaseContext(contextId);
  }

  /**
   * 온채널에서 마지막 크론 작업 이후 품절된 상품들을 크롤링하는 메서드
   *
   * @param lastCronTime - 마지막 크론 작업 실행 시간 (ISO 문자열 형식)
   * @param store - 크롤링 대상 스토어 이름
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<{stockProductCodes: string[], productDates: string[]}>} -
   *          품절된 상품 코드 배열과 해당 상품들의 등록/수정 날짜 배열을 포함하는 Promise
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 온채널 관리자 사이트에 로그인 (playwrightService 사용)
   * 2. 상품 목록 페이지로 이동하여 데이터 크롤링
   * 3. 마지막 크론 실행 시간 이후에 추가/수정된 품절 상품만 필터링
   * 4. 상품 코드와 등록/수정 날짜 정보 추출
   * 5. 크롤링 완료 후 Playwright 컨텍스트 리소스 해제
   *
   * 크롤링 과정에서 오류가 발생하면 에러 로그를 남기고 예외를 다시 던집니다.
   * finally 블록에서 컨텍스트 리소스를 확실히 해제하여 메모리 누수를 방지합니다.
   */
  async crawlingOnchSoldoutProducts(
    lastCronTime: string,
    store: string,
    cronId: string,
    type: string,
  ): Promise<{ stockProductCodes: string[]; productDates: string[] }> {
    const pageId = `page-${store}-${cronId}`;
    const contextId = `context-${store}-${cronId}`;

    const parsedLastCronTime = new Date(lastCronTime);

    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);

    try {
      await onchPage.goto(
        'https://www.onch3.co.kr/admin_mem_clo_list_2.php?ost=&sec=clo&ol=&npage=',
        {
          timeout: 60000,
        },
      );

      const { stockProductCodes, productDates } = await onchPage.evaluate(
        (lastCronTimeMillis) => {
          const stockProductCodesSet: Set<string> = new Set();
          const productDates = [];

          const rows = Array.from(document.querySelectorAll('tr')); // 모든 행 가져오기

          rows.forEach(async (row) => {
            const dateCell = row.querySelector('td.title_4.sub_title');
            const codeCell = row.querySelector('td.title_3.sub_title > b');

            if (dateCell && codeCell) {
              const dateText = dateCell.textContent?.trim() || '';
              const codeText = codeCell.textContent?.trim() || '';

              const productDate = new Date(dateText.slice(0, 10) + 'T' + dateText.slice(10));

              productDates.push(productDate.toISOString());

              if (lastCronTimeMillis && productDate.getTime() > lastCronTimeMillis) {
                stockProductCodes.push(codeText);
              }
            }
          });

          return { stockProductCodes: Array.from(stockProductCodesSet), productDates };
        },
        parsedLastCronTime ? parsedLastCronTime.getTime() : 0,
      );

      await this.playwrightService.releaseContext(contextId);

      return { stockProductCodes, productDates };
    } catch (error: any) {
      console.error(
        `${CronType.ERROR}${type}${cronId}: 온채널 품절상품 크롤링 오류\n`,
        error.message || error,
      );
      throw error;
    } finally {
      await this.playwrightService.releaseContext(contextId);
    }
  }

  /**
   * 온채널에 등록된 모든 판매 상품을 페이지네이션하며 크롤링하는 메서드
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 크롤링 대상 스토어 이름
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 크롤링 작업 완료 시 해결되는 Promise
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 온채널 관리자 사이트에 로그인 (playwrightService 사용)
   * 2. 페이지네이션을 통해 모든 상품 페이지를 순회하며 상품 ID 추출
   * 3. 각 페이지에서 상품 고유번호(num 파라미터)를 수집
   * 4. 빈 페이지가 나올 때까지 크롤링 계속 진행
   * 5. 수집된 모든 상품 ID를 crawlOnchDetailProducts 메서드로 전달하여 상세 정보 크롤링
   *
   * 10페이지마다 진행 상황을 로깅하여 크롤링 진행 상태를 모니터링할 수 있습니다.
   * 모든 상품 ID 수집 후 Playwright 컨텍스트를 해제하여 리소스 누수를 방지합니다.
   */
  async crawlOnchRegisteredProducts(cronId: string, store: string, type: string): Promise<void> {
    const pageId = `page-${store}-${cronId}`;
    const contextId = `context-${store}-${cronId}`;

    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);

    console.log(`${type}${cronId}: 온채널 판매상품 리스트업 시작...`);
    const allProductIds = [];
    let currentPage = 1;

    while (true) {
      await onchPage.goto(
        `https://www.onch3.co.kr/admin_mem_prd_list.html?npage=100&page=${currentPage}`,
        { waitUntil: 'networkidle' },
      );

      // 현재 페이지에서 상품 고유번호 추출 (셀렉터 최적화)
      const productIds = await onchPage.$$eval(
        'a[href^="./dbcenter_renewal/dbcenter_view.html?num="]',
        (links) =>
          links
            .map((link) => {
              const match = link.getAttribute('href')?.match(/num=(\d+)/);
              return match ? match[1] : null;
            })
            .filter((id) => id !== null),
      );

      // 상품 ID가 없으면 크롤링 중지
      if (productIds.length === 0) {
        console.log(`${type}${cronId}: 크롤링 중지 마지막 페이지-${currentPage}`);
        break;
      }

      allProductIds.push(...productIds);
      currentPage++;

      if (currentPage % 10 === 0)
        console.log(
          `${type}${cronId}: 진행중... 현재 ${currentPage}페이지, ${allProductIds.length}개 수집됨`,
        );
    }

    console.log(`${type}${cronId}: 온채널 판매상품 리스트업 완료 ${allProductIds.length} 개`);

    await this.crawlOnchDetailProducts(cronId, onchPage, contextId, allProductIds);
  }

  /**
   * 온채널 상품의 상세 정보 크롤링 메서드 (병렬옵션)
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param onchPage - 온채널 관리자 페이지 객체
   * @Param contextId - 현재 실행 중인 컨텍스트의 고유 식별자
   * @param allProductIds - 크롤링할 모든 상품 ID 배열
   *
   * @returns {Promise<void>} - 크롤링 작업 완료 시 해결되는 Promise
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 상품 ID 목록을 청크로 분할하여 병렬 처리 준비
   * 2. 각 청크마다 별도의 브라우저 컨텍스트와 페이지를 생성하여 병렬 크롤링 수행
   * 3. 각 상품 페이지에서 소비자가, 판매가, 배송비, 옵션 정보 등을 추출
   * 4. 배치 단위로 데이터베이스에 상세 정보 저장
   * 5. 진행률을 10% 단위로 로깅하여 작업 상태 모니터링
   * 6. 모든 작업 완료 후 사용된 브라우저 컨텍스트 리소스 해제
   *
   * Promise.all을 사용하여 여러 상품을 동시에 처리함으로써 크롤링 속도를 크게 향상시킵니다.
   * 각 워커는 최대 50개 상품을 처리한 후 데이터베이스에 저장하여 메모리 사용을 최적화합니다.
   */
  async crawlOnchDetailProducts(
    cronId: string,
    onchPage: Page,
    contextId: string,
    allProductIds: string[],
  ): Promise<void> {
    console.log(`${CronType.PRICE}${cronId}: 온채널 판매상품 상세정보 크롤링 시작...`);

    // 병렬 처리를 위한 설정
    const CONCURRENT_PAGES = 2; // 동시에 사용할 페이지 수
    const browser = onchPage.context(); // 기존 페이지의 컨텍스트 가져오기
    const pages = [onchPage]; // 기존 페이지도 작업에 활용

    for (let i = 1; i < CONCURRENT_PAGES; i++) {
      const newPage = await browser.newPage();
      pages.push(newPage);
    }

    // 상품 ID 배열을 청크로 분할
    const CHUNK_SIZE = Math.ceil(allProductIds.length / CONCURRENT_PAGES);
    const chunks = [];
    for (let i = 0; i < allProductIds.length; i += CHUNK_SIZE) {
      chunks.push(allProductIds.slice(i, i + CHUNK_SIZE));
    }

    // 공유 결과 저장소와 진행 상황 추적 변수
    let completedProducts = 0;
    const totalProducts = allProductIds.length;

    try {
      // 각 페이지에서 병렬로 작업 수행
      await Promise.all(
        chunks.map(async (chunk, pageIndex) => {
          const page = pages[pageIndex];
          const localDetails: OnchProductInterface[] = [];

          for (const productId of chunk) {
            try {
              await page.goto(
                `https://www.onch3.co.kr/dbcenter_renewal/dbcenter_view.html?num=${productId}`,
                {
                  timeout: 30000,
                  waitUntil: 'networkidle',
                },
              );

              // 상품 상세 정보 추출 - 기존 코드와 동일한 평가 로직
              const details = await page.evaluate(() => {
                const getTextContent = (selector: string) =>
                  document
                    .querySelector(selector)
                    ?.textContent?.trim()
                    .replace(/[^0-9]/g, '');

                const getOptionTextContent = (element: Element, selector: string) =>
                  element.querySelector(selector)?.textContent?.trim() || '';

                const productCodeElement = Array.from(document.querySelectorAll('li')).find((li) =>
                  li.querySelector('.prod_detail_title')?.textContent?.includes('제품코드'),
                );
                const productCode =
                  productCodeElement?.querySelector('div:nth-child(2)')?.textContent!.trim() ||
                  null;

                // 소비자가
                const consumerPrice =
                  +getTextContent('.price_info li:nth-child(1) .prod_cus_price') || null;

                // 판매사가
                const sellerPrice =
                  +getTextContent('.price_info li:nth-child(2) div:nth-child(2)') || null;

                // 배송비
                const shippingCostElement = Array.from(document.querySelectorAll('li')).find((li) =>
                  li.querySelector('.prod_detail_title')?.textContent?.includes('택배비/택배사'),
                );
                const shippingCostText =
                  shippingCostElement?.querySelector('div:nth-child(2)')?.textContent || null;
                const shippingCostMatch =
                  shippingCostText && shippingCostText.match(/일반\s([\d,]+)원/);

                const shippingCost = shippingCostMatch
                  ? +shippingCostMatch[1].replace(/,/g, '')
                  : null;

                const onchItems = Array.from(document.querySelectorAll('ul li'))
                  .filter((li) => li.querySelector('.detail_page_name')) // 옵션명이 존재하는 li만 포함
                  .map((li) => {
                    const optionName = getOptionTextContent(li, '.detail_page_name');
                    const consumerPrice = getOptionTextContent(li, '.detail_page_price_2').replace(
                      /[^0-9]/g,
                      '',
                    );
                    const sellerPrice = getOptionTextContent(li, '.detail_page_price_3').replace(
                      /[^0-9]/g,
                      '',
                    );
                    return {
                      itemName: optionName,
                      consumerPrice: +consumerPrice || null,
                      sellerPrice: +sellerPrice || null,
                    };
                  });

                return {
                  productCode,
                  consumerPrice,
                  sellerPrice,
                  shippingCost,
                  onchItems,
                };
              });

              localDetails.push(details);

              // 로컬 배치 크기에 도달하면 동기화하여 메인 배열로 이동
              if (localDetails.length >= 50) {
                // 데이터베이스에 저장
                await this.onchRepository.saveOnchProductDetails([...localDetails]);
                localDetails.length = 0;
              }

              // 진행 상황 업데이트 - 원자적 연산으로 증가
              completedProducts++;

              // 진행률 로깅 (10% 단위)
              if (
                completedProducts % Math.ceil(totalProducts / 10) === 0 ||
                completedProducts === totalProducts
              ) {
                console.log(
                  `${CronType.PRICE}${cronId}: 진행률 ${completedProducts}/${totalProducts} (${Math.round((completedProducts / totalProducts) * 100)}%)`,
                );
              }
            } catch (error) {
              console.error(
                `${CronType.ERROR}${cronId}: 상품 ID ${productId} 크롤링 중 오류 발생`,
                error,
              );
            }
          }

          // 남은 로컬 배치 처리
          if (localDetails.length > 0) {
            await this.onchRepository.saveOnchProductDetails([...localDetails]);
          }
        }),
      );

      // 추가로 생성한 페이지 닫기 (첫 번째 페이지는 유지)
      for (let i = 1; i < pages.length; i++) {
        await pages[i].close();
      }

      // 컨텍스트 해제
      await this.playwrightService.releaseContext(contextId);
      console.log(`${CronType.PRICE}${cronId}: 온채널 판매상품 상세정보 크롤링 완료`);
    } catch (error) {
      console.error(`${CronType.ERROR}${cronId}: 병렬 크롤링 중 심각한 오류 발생`, error);

      // 추가로 생성한 페이지 정리
      for (let i = 1; i < pages.length; i++) {
        try {
          await pages[i].close();
        } catch (e) {
          // 이미 닫힌 페이지는 무시
        }
      }

      // 컨텍스트 해제
      await this.playwrightService.releaseContext(contextId);
      throw error;
    }
  }

  /**
   * 쿠팡 주문 정보를 바탕으로 온채널에서 자동 발주를 수행
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 발주를 수행할 스토어 이름
   * @param newOrderProducts - 발주할 쿠팡 주문 정보 배열
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<Array>} - 각 주문 항목별 발주 결과 객체를 포함하는 배열을 반환하는 Promise
   *                            성공 시: {status: 'success', orderId, ordererName, receiverName, sellerProductName, sellerProductItemName, shippingCount}
   *                            실패 시: {status: 'failed', orderId, ordererName, receiverName, productCode, sellerProductName,
   *                                    sellerProductItemName, shippingCount, safeNumber, fullAddress, error}
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류는 개별 주문 항목 처리에서 캐치되어 결과 배열에 포함됨
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 온채널 관리자 사이트에 로그인 (playwrightService 사용)
   * 2. 각 쿠팡 주문 및 하위 주문 항목에 대해 다음 작업 수행:
   *    a. 상품 정보 검증 (쿠팡에서 받은 상품명과 온채널 상품명 일치 여부 확인)
   *    b. 상품코드로 온채널에서 상품 검색
   *    c. 주문 항목의 옵션 선택
   *    d. 주문 수량 설정
   *    e. 주문자, 수령인 등 주문 상세 정보 입력
   *    f. 주문 완료 버튼 클릭 및 확인 대화상자 자동 수락
   *    g. 주문 결과 기록
   * 3. 모든 주문 처리 완료 후 Playwright 컨텍스트 리소스 해제
   *
   * 주문 정보 검증 과정에서 불일치가 발견되면 로그에 경고 메시지를 출력하지만,
   * 발주 프로세스는 계속 진행됩니다. 각 주문 항목별로 성공/실패 결과를 기록하여 반환합니다.
   */
  async automaticOrdering(
    cronId: string,
    store: string,
    newOrderProducts: CoupangOrderInfo[],
    type: string,
  ): Promise<Array<any>> {
    const contextId = `context-${store}-${cronId}`;
    const pageId = `page-${store}-${cronId}`;
    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);
    const results = []; // 발주 결과 저장 배열

    try {
      for (const order of newOrderProducts) {
        for (const item of order.orderItems) {
          const sellerProductName = item.sellerProductName;
          const sellerProductItemName = item.sellerProductItemName; // 옵션명
          const productCode = item.externalVendorSkuCode;
          const vendorItemName = item.vendorItemName; // 상품 + 옵션 쏘 지저분
          const exposedProductName = `${item.sellerProductName}, ${item.sellerProductItemName}`;

          const productNameWithoutCode = sellerProductName.replace(/^\S+\s+/, '');
          const combinedName = productNameWithoutCode + ', ' + sellerProductItemName;

          console.log(`${type}${cronId}: ${vendorItemName}`);
          console.log(`${type}${cronId}: ${exposedProductName} + ${item.shippingCount}`);
          const isValid = vendorItemName.includes(combinedName);

          if (!isValid)
            console.log(`❗️${type}${cronId}: 발주 확인 필요 ${vendorItemName} = ${combinedName}`);

          try {
            // 상품검색
            await this.searchProduct(onchPage, productCode, cronId, type);

            // 옵션설정
            await this.selectProductOption(onchPage, sellerProductItemName, cronId, type);

            // 수량설정
            await this.setProductQuantity(onchPage, item.shippingCount, cronId, type);

            // 주문 정보 입력
            await this.fillOrderDetails(onchPage, order, cronId, type);

            // 주문 처리
            const completeButtonSelector = '.btnOrderComplete';
            onchPage.once('dialog', async (dialog) => {
              await dialog.accept();
            });

            await onchPage.click(completeButtonSelector);
            await onchPage.waitForLoadState('networkidle');

            await onchPage.goto('https://www.onch3.co.kr/index.php');

            results.push({
              status: 'success',
              orderId: order.orderId,
              ordererName: order.orderer.name,
              receiverName: order.receiver.name,
              sellerProductName: item.sellerProductName,
              sellerProductItemName: item.sellerProductItemName,
              shippingCount: item.shippingCount,
            });
          } catch (error: any) {
            results.push({
              status: 'failed',
              orderId: order.orderId,
              ordererName: order.orderer.name,
              receiverName: order.receiver.name,
              productCode: productCode,
              sellerProductName: item.sellerProductName,
              sellerProductItemName: item.sellerProductItemName,
              shippingCount: item.shippingCount,
              safeNumber: order.receiver.safeNumber,
              fullAddress: order.receiver.addr1 + order.receiver.addr2,
              error: error.message,
            });
          }
        }
      }
      await this.playwrightService.releaseContext(contextId);

      return results;
    } catch (error: any) {
      console.error(`${CronType.ERROR}${type}${cronId}: 발주 중 오류 발생`, error);
    } finally {
      await this.playwrightService.releaseContext(contextId);
    }
  }

  /**
   * 온채널 사이트에서 상품 코드로 상품을 검색하고 발주 페이지로 이동하는 메서드
   *
   * @param page - 작업을 수행할 Playwright 페이지 객체
   * @param query - 검색할 상품 코드
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 검색 및 발주 페이지 이동이 완료되면 해결되는 Promise
   *
   * @throws {Error} - 상품 검색 후 주문 버튼을 찾을 수 없는 경우 발생하는 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 검색 입력란에 상품 코드 입력 (권장되는 page.fill() 메서드 사용)
   * 2. 엔터 키를 눌러 검색 실행
   * 3. 검색 결과가 로드될 때까지 대기
   * 4. 주문 버튼을 찾아 클릭하여 발주 페이지로 이동
   * 5. 발주 페이지가 완전히 로드될 때까지 대기
   *
   * 검색 결과에서 주문 버튼을 찾을 수 없는 경우 오류를 발생시킵니다.
   */
  private async searchProduct(
    page: Page,
    query: string,
    cronId: string,
    type: string,
  ): Promise<void> {
    console.log(`${type}${cronId}: 상품 검색 시작`);

    // page.type() 대신 권장되는 page.fill() 사용
    await page.fill('#prd_sear_txt', query);

    // Promise.all로 네비게이션과 액션 동시 대기
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.keyboard.press('Enter'),
    ]);

    // 주문 버튼 존재 확인
    const orderButtonSelector = '.btn_order';

    try {
      // 주문 버튼이 나타날 때까지 명시적으로 대기 (타임아웃 추가)
      await page.waitForSelector(orderButtonSelector, { timeout: 5000 });
    } catch (error) {
      throw new Error(
        `${CronType.ERROR}${CronType.ORDER}${cronId}: 제품 코드에 대한 주문 버튼을 찾을 수 없습니다: ${query}`,
      );
    }

    // 주문 버튼 클릭 후 페이지 로드 대기
    await Promise.all([page.waitForLoadState('networkidle'), page.click(orderButtonSelector)]);

    console.log(`${type}${cronId}: 발주 페이지 진입`);
  }

  /**
   * 온채널 발주 페이지에서 주문할 상품의 옵션을 선택하는 메서드
   *
   * @param page - 작업을 수행할 Playwright 페이지 객체
   * @param option - 선택할 옵션명 (쿠팡의 sellerProductItemName)
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 옵션 선택이 완료되면 해결되는 Promise
   *
   * @throws {Error} - 옵션 드롭다운에서 일치하는 옵션을 찾을 수 없는 경우 발생하는 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 페이지에서 옵션 드롭다운(.selectOptionList) 요소를 찾아 모든 옵션을 추출
   * 2. 추출한 모든 옵션을 콘솔에 출력하여 디버깅 용이성 제공
   * 3. 공백을 제거한 정규화된 텍스트 비교를 통해 지정된 옵션과 일치하는 항목 검색
   *    (정확히 일치하거나 옵션 텍스트에 지정된 옵션이 포함된 경우 선택)
   * 4. 일치하는 옵션을 찾으면 해당 옵션의 value를 설정하고 change 이벤트 발생
   * 5. 일치하는 옵션을 찾지 못하면 상세한 오류 메시지와 함께 예외 발생
   *
   * 옵션 텍스트 비교 시 공백 차이로 인한 불일치를 방지하기 위해
   * normalizeText 함수를 사용하여 모든 공백을 제거합니다.
   */
  private async selectProductOption(
    page: Page,
    option: string,
    cronId: string,
    type: string,
  ): Promise<void> {
    console.log(`${type}${cronId}: 옵션 설정 시작`);

    // 모든 옵션 텍스트를 추출하여 반환
    const allOptions = await page.evaluate(() => {
      const select = document.querySelector('.selectOptionList') as HTMLSelectElement;
      if (!select) return [];

      return Array.from(select.options).map((opt) => ({
        text: opt.textContent?.trim() || '',
        value: opt.value,
      }));
    });

    // Node.js 환경에서 옵션 리스트 출력
    console.log('사용 가능한 모든 옵션:');
    allOptions.forEach((opt, index) => {
      console.log(`${index}: "${opt.text}" (value: ${opt.value})`);
    });

    const normalizeText = (text: string) => text.replace(/\s+/g, '');

    // 옵션 찾기
    const targetOption = allOptions.find(
      (opt) =>
        normalizeText(opt.text) === normalizeText(option) ||
        normalizeText(opt.text).includes(normalizeText(option)),
    );

    if (!targetOption) {
      const errorMsg = `${CronType.ERROR}${type}${cronId}: 옵션을 찾을 수 없습니다 "${normalizeText(option)}"`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // 찾은 옵션 선택
    await page.evaluate((optionValue) => {
      const select = document.querySelector('.selectOptionList') as HTMLSelectElement;
      if (!select) throw new Error('옵션 리스트를 찾을 수 없습니다.');

      select.value = optionValue;
      select.dispatchEvent(new Event('change'));
    }, targetOption.value);

    console.log(`${type}${cronId}: "${targetOption.text}" 옵션 설정 완료`);
  }

  /**
   * 상품 수량을 설정하는 메서드
   *
   * @param page - Playwright Page 객체
   * @param quantity - 설정할 상품 수량
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 수량 설정 작업이 완료되면 resolve되는 Promise
   *
   * @throws {Error} - 수량 설정 과정에서 발생하는 오류 (요소를 찾을 수 없거나 수량이 유효하지 않은 경우)
   *
   * @description
   * 이 메서드는 온채널 관리자 페이지에서 상품 발주 시 수량을 설정하는 기능을 담당합니다.
   * 1. 수량 입력 필드를 찾아 대기
   * 2. 기존 값을 모두 선택(triple-click)하여 지움
   * 3. 새로운 수량 값을 입력
   * 4. 입력이 안정적으로 처리되도록 짧은 대기 시간 추가
   */
  private async setProductQuantity(
    page: Page,
    quantity: number,
    cronId: string,
    type: string,
  ): Promise<void> {
    if (!quantity)
      throw new Error(`${CronType.ERROR}${type}${cronId}: 발주 개수를 찾을 수 없습니다.`);

    const optionQuantitySelector = '.optionQuantity';

    try {
      const quantityField = await page.waitForSelector(optionQuantitySelector, {
        state: 'visible',
        timeout: 5000,
      });

      // const element = await page.$(optionQuantitySelector);
      // if (element) {
      // 	const boundingBox = await element.boundingBox();
      // 	if (boundingBox) {
      // 		await page.mouse.click(
      // 			boundingBox.x + boundingBox.width / 2,
      // 			boundingBox.y + boundingBox.height / 2,
      // 			{ button: 'left', clickCount: 3 },
      // 		);
      // 	} else {
      // 		throw new Error('Bounding box를 찾을 수 없습니다.');
      // 	}
      // } else {
      // 	throw new Error('선택한 요소를 찾을 수 없습니다.');
      // }

      // 기존 텍스트를 모두 선택하기 위해 triple-click 사용
      await quantityField.click({ clickCount: 3 });

      // 새 수량 값 입력
      await quantityField.fill(quantity.toString());

      await page.waitForTimeout(200);
    } catch (error: any) {
      if (error instanceof Error) {
        throw new Error(`${CronType.ERROR}${type}${cronId}: 수량 설정 실패 - ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 온채널 발주 페이지에서 주문 상세 정보를 입력하는 메서드
   *
   * @param page - Playwright Page 객체
   * @param order - 쿠팡에서 받은 주문 정보 객체
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 주문 상세 정보 입력이 완료되면 resolve되는 Promise
   *
   * @throws {Error} - 주문 정보가 불완전하거나 입력 과정에서 오류가 발생하는 경우
   *
   * @description
   * 이 메서드는 온채널 발주 페이지에서 다음 주문 정보를 입력합니다:
   * 1. 수취인 이름
   * 2. 안심번호(연락처)
   * 3. 우편번호
   * 4. 배송지 주소
   * 5. 배송 메시지(있는 경우)
   *
   * 정보 입력 전 필수 필드(수취인 이름, 안심번호, 주소)가 존재하는지 검증합니다.
   */
  private async fillOrderDetails(
    page: Page,
    order: any,
    cronId: string,
    type: string,
  ): Promise<void> {
    const receiver = order!.receiver;
    // 수취인 정보 유효성 검사
    if (!receiver.name || !receiver.safeNumber)
      throw new Error(`${CronType.ERROR}${type}${cronId}: 수취인 정보를 찾을 수 없습니다.`);

    // 주소 정보 유효성 검사
    const fullAddress = `${receiver.addr1 || ''} ${receiver.addr2 || ''}`.trim();
    if (!receiver.postCode || !fullAddress) {
      throw new Error(`${CronType.ERROR}${type}${cronId}: 수취인 주소를 찾을 수 없습니다.`);
    }

    const nameField = page.locator('input.orderName');
    const phoneField = page.locator('input.orderPhone');
    const postcodeField = page.locator('input.postcode');
    const addressField = page.locator('input.orderAddress');
    const commentField = page.locator('textarea.comment');

    // 병렬로 요소들이 로드될 때까지 대기
    await Promise.all([
      nameField.waitFor({ state: 'visible' }),
      phoneField.waitFor({ state: 'visible' }),
      postcodeField.waitFor({ state: 'visible' }),
      addressField.waitFor({ state: 'visible' }),
      commentField.waitFor({ state: 'visible' }),
    ]);

    // 각 필드에 데이터 입력
    // fill 메서드는 내부적으로 요소가 준비될 때까지 대기함
    await nameField.fill(receiver.name);
    await phoneField.fill(receiver.safeNumber);
    await postcodeField.fill(receiver.postCode);
    await addressField.fill(fullAddress);

    // 배송 메시지는 선택 사항이므로 null 또는 undefined 체크
    const parcelMessage = order.parcelPrintMessage || '';
    await commentField.fill(parcelMessage);
  }

  /**
   * 온채널에서 주문 완료 처리를 수행하는 메서드
   *
   * @param page - Playwright Page 객체
   * @param item - 현재 처리 중인 주문 항목 정보 (상품명, 발송 수량 등)
   * @param order - 주문의 상위 정보 (주문 ID 등)
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<Object>} - 주문 처리 결과 객체를 반환하는 Promise
   *                             성공 시: {status: 'success', orderId, sellerProductName, shippingCount}
   *
   * @throws {Error} - 주문 완료 과정에서 발생하는 오류
   *
   * @description
   * 이 메서드는 온채널 발주 페이지에서 다음 작업을 수행합니다:
   * 1. 주문 완료 버튼을 클릭
   * 2. 확인 대화상자(dialog)를 자동으로 수락
   * 3. 페이지 이동 및 네트워크 요청 완료를 대기
   * 4. 성공적으로 처리된 주문의 결과 정보 반환
   */
  private async processOrder(
    page: Page,
    item: any,
    order: any,
    cronId: string,
    type: string,
  ): Promise<any> {
    const completeButton = page.locator('.btnOrderComplete');
    await completeButton.waitFor({ state: 'visible' });

    // 확인 대화상자가 표시될 때 자동으로 수락하도록 이벤트 리스너 설정
    // 이벤트 리스너는 단 한 번만 실행되도록 once 사용
    page.once('dialog', async (dialog) => {
      console.log(`${type}${cronId}: 확인 대화상자 "${dialog.message()}" 자동 수락`);
      await dialog.accept();
    });

    await completeButton.click();

    // Playwright의 개선된 대기 메커니즘 사용
    // waitForNavigation 대신 waitForLoadState 사용
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    return {
      status: 'success',
      orderId: order.orderId,
      sellerProductName: item.sellerProductName,
      shippingCount: item.shippingCount,
    };
  }

  /**
   * 온채널에서 운송장 정보를 추출하는 메서드
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 스토어 식별자 (온채널 계정 구분용)
   * @param lastCronTime - 마지막으로 크론이 실행된 시간 (이 시간 이후의 주문만 처리)
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<OnchSoldout[]>} - 추출된 운송장 정보 배열을 반환하는 Promise
   *
   * @description
   * 이 메서드는 온채널 사이트에서 다음 작업을 수행합니다:
   * 1. 온채널 사이트에 로그인하고 관리자 페이지로 이동
   * 2. 판매 완료된 주문 목록에서 마지막 크론 실행 시간 이후의 데이터만 추출
   * 3. 고객 정보, 배송 상태, 결제 방법, 택배사, 송장번호 등의 정보 수집
   * 4. 페이지네이션을 통해 모든 페이지의 데이터를 스크래핑
   * 5. 작업 완료 후 Playwright 컨텍스트 해제
   */
  async waybillExtraction(
    cronId: string,
    store: string,
    lastCronTime: Date,
    type: string,
  ): Promise<OnchSoldout[]> {
    // 브라우저 컨텍스트와 페이지를 구분하기 위한 고유 ID 생성
    const contextId = `context-${store}-${cronId}`;
    const pageId = `page-${store}-${cronId}`;

    // 온채널 사이트에 로그인하고 페이지 객체 획득
    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);

    try {
      // 관리자 제품 페이지로 이동 (타임아웃 무제한 설정)
      await onchPage.goto('https://www.onch3.co.kr/admin_mem_prd.html', {
        timeout: 0,
      });

      // 페이지 로딩 안정화를 위한 짧은 대기
      await onchPage.waitForTimeout(1000);

      console.log(`${type}${cronId}: 운송장 추출 시작`);

      // 결과를 저장할 배열 및 페이지네이션 관련 변수 초기화
      let onchResults: OnchSoldout[] = [];
      let currentPage = 1;
      let hasNextPage = true;

      // 모든 페이지의 데이터를 수집할 때까지 반복
      while (hasNextPage) {
        // TypeScript 타입 안전성을 위한 인터페이스 정의
        interface EvalArgs {
          lastCronTime: string;
          courierNames: string[];
        }

        // 현재 페이지의 제품 목록에서 데이터 추출
        const rows = await onchPage.$$eval<OnchSoldout[], EvalArgs>(
          '.prd_list_li',
          (elements, args) => {
            const { lastCronTime, courierNames } = args;

            // 각 행에서 필요한 정보 추출 및 필터링
            return elements
              .map((row) => {
                // 날짜 정보 추출 및 검증
                const dateElement = row.querySelector('.prd_list_date font[color="#135bc8"]');
                if (!dateElement) return null;

                const dateText = dateElement.textContent.trim();
                // 날짜 형식 변환 (YYYY-MM-DD HH:MM:SS → ISO 형식)
                const formattedDateText = `${dateText.slice(0, 10)}T${dateText.slice(10)}`;
                const rowDate = new Date(formattedDateText);

                // 마지막 크론 실행 시간보다 이전 데이터는 제외
                if (rowDate <= new Date(lastCronTime)) return null;

                // 고객 이름 및 연락처 정보 추출
                const nameElement = row.querySelector('.prd_list_name div');
                const name = nameElement?.childNodes[0]?.textContent.trim() || '';
                const phone = nameElement?.querySelector('font')?.textContent.trim() || '';

                // 배송 상태 및 결제 방법 정보 추출
                const stateElement = row.querySelector('.prd_list_state div');
                const state = stateElement?.querySelector('b')?.textContent.trim() || '';
                const paymentMethod =
                  stateElement?.querySelector('font[style*="color:#555555"]')?.textContent.trim() ||
                  '';

                // 택배사 정보 추출 (courierNames 배열의 택배사 이름과 일치하는지 검사)
                const courierRegex = new RegExp(`(${courierNames.join('|')})`, 'i'); // 대소문자 무시 옵션 추가
                const stateText = stateElement?.textContent || '';
                const courierMatch = stateText.match(courierRegex);
                const courier = courierMatch ? courierMatch[1] : '';

                // 송장번호 추출
                const trackingNumber =
                  stateElement
                    ?.querySelector('font[style*="font-size: 15px"]')
                    ?.textContent.trim() || '';

                // 추출된 정보를 객체로 반환
                return {
                  name,
                  phone,
                  state,
                  paymentMethod,
                  courier,
                  trackingNumber,
                };
              })
              .filter((item): item is OnchSoldout => item !== null); // null 항목 제거 및 타입 가드 적용
          },
          {
            lastCronTime: lastCronTime.toISOString(), // Date 객체를 ISO 문자열로 변환
            courierNames,
          },
        );

        // 유효한 데이터가 없으면 페이지 탐색 종료
        if (rows.length === 0) {
          console.log(`${type}${cronId}: 더 이상 유효한 데이터가 없습니다. 루프를 종료합니다.`);
          hasNextPage = false;
          break;
        }

        // 추출된 데이터를 결과 배열에 추가
        onchResults = onchResults.concat(rows);

        // 다음 페이지 링크 확인
        const nextPageSelector = `.prd_list_bottom a[href*="page=${currentPage + 1}"]`;
        const nextPageLink = await onchPage.$(nextPageSelector);

        if (nextPageLink) {
          console.log(`${type}${cronId}: 페이지 ${currentPage + 1}로 이동 중...`);

          // Playwright에서는 waitForNavigation과 click을 함께 사용하는 것이 권장됨
          try {
            // Promise.all을 사용하여 클릭과 페이지 로드를 동시에 대기
            await Promise.all([
              onchPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
              nextPageLink.click(),
            ]);

            // 페이지 전환 후 잠시 대기하여 콘텐츠 로딩 보장
            await onchPage.waitForTimeout(500);

            currentPage++;
          } catch (error: any) {
            // 페이지 이동 실패 시 오류 로깅 및 루프 종료
            console.error(
              `${CronType.ERROR}${type}${cronId}: 페이지 ${currentPage + 1}로 이동 실패\n`,
              error.response?.data || error.message,
            );
            hasNextPage = false;
          }
        } else {
          // 다음 페이지가 없으면 루프 종료
          console.log(`${type}${cronId}: 더 이상 페이지가 없습니다.`);
          hasNextPage = false;
        }
      }

      return onchResults;
    } catch (error: any) {
      // 전체 프로세스 오류 처리
      console.error(
        `${CronType.ERROR}${type}${cronId}: 운송장 추출 중 오류 발생: ${error.message}`,
      );
      return [];
    } finally {
      // 작업 완료 후 브라우저 컨텍스트 해제 (리소스 정리)
      await this.playwrightService.releaseContext(contextId);
    }
  }
}
