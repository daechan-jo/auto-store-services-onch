import { PlaywrightService } from '@daechanjo/playwright';
import { Injectable } from '@nestjs/common';

import { CronType } from '../../../../models/types/cron.type';
import { Dialog } from '../../../../models/interfaces/dialog.interface';
import { OnchRepository } from '../infrastructure/repository/onch.repository';

import { Browser, BrowserContext, Page, chromium, firefox, webkit, BrowserType } from 'playwright';

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
    const BATCH_SIZE = 3; // 동시에 처리할 최대 페이지 수
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
  ) {
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
          const stockProductCodesSet = new Set();
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

  async crawlOnchRegisteredProducts(cronId: string, store: string, type: string) {
    const onchPage = await this.puppeteerService.loginToOnchSite(store);

    console.log(`${type}${cronId}: 온채널 판매상품 리스트업 시작...`);
    const allProductIds = [];
    let currentPage = 1;

    while (true) {
      await onchPage.goto(
        `https://www.onch3.co.kr/admin_mem_prd_list.html?npage=100&page=${currentPage}`,
      );

      // 현재 페이지에서 상품 고유번호 추출
      const productIds = await onchPage.evaluate(() => {
        const links = Array.from(
          document.querySelectorAll('a[href^="./dbcenter_renewal/dbcenter_view.html?num="]'),
        );
        return links
          .map((link) => {
            const match = link.getAttribute('href')?.match(/num=(\d+)/);
            return match ? match[1] : null;
          })
          .filter((id) => id !== null);
      });

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

    await this.crawlOnchDetailProducts(cronId, onchPage, allProductIds);
  }

  async crawlOnchDetailProducts(cronId: string, onchPage: Page, allProductIds: string[]) {
    const detailsBatch: OnchProductDto[] = [];
    console.log(`${CronType.PRICE}${cronId}: 온채널 판매상품 상세정보 크롤링 시작...`);

    for (const [i, productId] of allProductIds.entries()) {
      await onchPage.goto(
        `https://www.onch3.co.kr/dbcenter_renewal/dbcenter_view.html?num=${productId}`,
        { timeout: 0 },
      );

      // 소비자가, 판매가, 일반 배송비 추출
      const details = await onchPage.evaluate(() => {
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
          productCodeElement?.querySelector('div:nth-child(2)')?.textContent!.trim() || null;

        // 소비자가
        const consumerPrice =
          +getTextContent('.price_info li:nth-child(1) .prod_cus_price') || null;

        // 판매사가
        const sellerPrice = +getTextContent('.price_info li:nth-child(2) div:nth-child(2)') || null;

        // 배송비
        const shippingCostElement = Array.from(document.querySelectorAll('li')).find((li) =>
          li.querySelector('.prod_detail_title')?.textContent?.includes('택배비/택배사'),
        );
        const shippingCostText =
          shippingCostElement?.querySelector('div:nth-child(2)')?.textContent || null;
        const shippingCostMatch = shippingCostText && shippingCostText.match(/일반\s([\d,]+)원/);

        const shippingCost = shippingCostMatch ? +shippingCostMatch[1].replace(/,/g, '') : null;

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

      detailsBatch.push(details);

      // 배치 크기만큼 쌓이면 저장 후 배열 초기화
      if (detailsBatch.length >= 50) {
        await this.onchRepository.saveOnchProductDetails(detailsBatch);
        detailsBatch.length = 0;
      }
      if ((i + 1) % Math.ceil(allProductIds.length / 10) === 0 || i + 1 === allProductIds.length)
        console.log(
          `${CronType.PRICE}${cronId}: 진행률 ${i + 1}/${allProductIds.length} (${Math.round(((i + 1) / allProductIds.length) * 100)}%)`,
        );
    }
    if (detailsBatch.length > 0) {
      await this.onchRepository.saveOnchProductDetails(detailsBatch);
    }

    await this.puppeteerService.closeAllPages();
    console.log(`${CronType.PRICE}${cronId}: 온채널 판매상품 상세정보 크롤링 완료`);
  }

  async automaticOrdering(
    cronId: string,
    store: string,
    newOrderProducts: CoupangOrderData[],
    type: string,
  ) {
    const onchPage = await this.puppeteerService.loginToOnchSite(store);

    const results = []; // 발주 결과 저장 배열
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
          await onchPage.waitForNavigation({ waitUntil: 'networkidle2' });

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
    await this.puppeteerService.closeAllPages();

    return results;
  }

  private async searchProduct(page: Page, query: string, cronId: string, type: string) {
    console.log(`${type}${cronId}: 상품 검색 시작`);

    await page.type('#prd_sear_txt', query, { delay: 100 });
    await page.keyboard.press('Enter');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const orderButtonSelector = '.btn_order';
    if (!(await page.$(orderButtonSelector))) {
      throw new Error(
        `${CronType.ERROR}${CronType.ORDER}${cronId}: 제품 코드에 대한 주문 버튼을 찾을 수 없습니다: ${query}`,
      );
    }

    await page.click(orderButtonSelector);

    console.log(`${type}${cronId}: 발주 페이지 진입`);

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async selectProductOption(page: Page, option: string, cronId: string, type: string) {
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

    // todo 공백을 제거하고 비교하는 함수. 유틸로 분리
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

  private async setProductQuantity(page: Page, quantity: number, cronId: string, type: string) {
    const optionQuantitySelector = '.optionQuantity';
    await page.waitForSelector(optionQuantitySelector, { timeout: 5000 });

    if (!quantity) throw new Error('발주 개수를 찾을 수 없습니다.');

    const element = await page.$(optionQuantitySelector);
    if (element) {
      const boundingBox = await element.boundingBox();
      if (boundingBox) {
        await page.mouse.click(
          boundingBox.x + boundingBox.width / 2,
          boundingBox.y + boundingBox.height / 2,
          { count: 3 },
        );
      } else {
        throw new Error('Bounding box를 찾을 수 없습니다.');
      }
    } else {
      throw new Error('선택한 요소를 찾을 수 없습니다.');
    }

    await page.type(optionQuantitySelector, quantity.toString(), { delay: 10 });

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  private async fillOrderDetails(page: Page, order: any, cronId: string, type: string) {
    const receiver = order!.receiver;
    if (!receiver.name || !receiver.safeNumber)
      throw new Error(`${CronType.ERROR}${type}${cronId}: 수취인 정보를 찾을 수 없습니다.`);

    const fullAddress = `${receiver.addr1} ${receiver.addr2}`;
    if (!receiver.postCode || !fullAddress)
      throw new Error(`${CronType.ERROR}${type}${cronId}: 수취인 주소를 찾을 수 없습니다.`);

    await page.type('input.orderName', receiver.name, { delay: 10 });
    await page.type('input.orderPhone', receiver.safeNumber, { delay: 10 });
    await page.type('input.postcode', receiver.postCode, { delay: 10 });
    await page.type('input.orderAddress', fullAddress, { delay: 10 });
    await page.type('textarea.comment', order.parcelPrintMessage || '', { delay: 10 });
  }

  private async processOrder(
    page: Page,
    item: any,
    order: any,
    cronId: string,
    type: string,
  ): Promise<any> {
    const completeButtonSelector = '.btnOrderComplete';
    page.once('dialog', async (dialog) => await dialog.accept());

    await page.click(completeButtonSelector);
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    return {
      status: 'success',
      orderId: order.orderId,
      sellerProductName: item.sellerProductName,
      shippingCount: item.shippingCount,
    };
  }

  async waybillExtraction(cronId: string, store: string, lastCronTime: Date, type: string) {
    const onchPage = await this.puppeteerService.loginToOnchSite(store);

    await onchPage.goto('https://www.onch3.co.kr/admin_mem_prd.html', {
      timeout: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log(`${type}${cronId}: 운송장 추출 시작`);

    let onchResults = [];
    let currentPage = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const rows = await onchPage.$$eval(
        '.prd_list_li',
        (elements, lastCronTime, courierNames) => {
          return elements
            .map((row) => {
              // 날짜 가져오기
              const dateElement = row.querySelector('.prd_list_date font[color="#135bc8"]');
              if (!dateElement) return;

              const dateText = dateElement.textContent.trim();

              const formattedDateText = `${dateText.slice(0, 10)}T${dateText.slice(10)}`;

              const rowDate = new Date(formattedDateText);

              if (rowDate <= new Date(lastCronTime)) return;

              // 필요한 데이터 추출
              const nameElement = row.querySelector('.prd_list_name div');
              const name = nameElement?.childNodes[0]?.textContent.trim() || '';
              const phone = nameElement?.querySelector('font')?.textContent.trim() || '';

              // 배송 상태 및 세부 정보
              const stateElement = row.querySelector('.prd_list_state div');
              const state = stateElement?.querySelector('b')?.textContent.trim() || '';
              const paymentMethod =
                stateElement?.querySelector('font[style*="color:#555555"]')?.textContent.trim() ||
                '';

              // 택배사 정보
              const courierRegex = new RegExp(`(${courierNames.join('|')})`);
              const stateText = (stateElement as HTMLElement)?.innerText || '';
              const courierMatch = stateText.match(courierRegex);
              const courier = courierMatch ? courierMatch[1] : '';

              // 송장 정보
              const trackingNumber =
                stateElement?.querySelector('font[style*="font-size: 15px"]')?.textContent.trim() ||
                '';

              return {
                name,
                phone,
                state,
                paymentMethod,
                courier,
                trackingNumber,
              };
            })
            .filter(Boolean);
        },
        lastCronTime,
        courierNames,
      );

      if (rows.length === 0) {
        console.log(`${type}${cronId}: 더 이상 유효한 데이터가 없습니다. 루프를 종료합니다.`);
        hasNextPage = false;
        break;
      }

      onchResults = onchResults.concat(rows);

      const nextPageSelector = `.prd_list_bottom a[href*="page=${currentPage + 1}"]`;
      const nextPageLink = await onchPage.$(nextPageSelector);

      if (nextPageLink) {
        console.log(`${type}${cronId}: 페이지 ${currentPage + 1}로 이동 중...`);
        await nextPageLink.click();
        try {
          await onchPage.waitForNavigation({ waitUntil: 'domcontentloaded' });
        } catch (error: any) {
          console.error(
            `${CronType.ERROR}${type}${cronId}: 페이지 ${currentPage + 1}로 이동 실패\n`,
            error.response?.data || error.message,
          );
          hasNextPage = false;
        }
        currentPage++;
      } else {
        console.log(`${CronType.ERROR}${type}${cronId}: 더 이상 페이지가 없습니다.`);
        hasNextPage = false;
      }
    }

    if (onchResults.length === 0) {
      await this.puppeteerService.closeAllPages();
      return [];
    }
    await this.puppeteerService.closeAllPages();
    return onchResults;
  }
}
