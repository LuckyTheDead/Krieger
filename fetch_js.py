#!/usr/bin/env python3
import sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import WebDriverException, TimeoutException

url = sys.argv[1]

options = Options()
options.headless = True
options.add_argument("--disable-gpu")
options.add_argument("--no-sandbox")
options.add_argument("--log-level=3")

driver = webdriver.Firefox(options=options)
driver.set_page_load_timeout(20)

def scroll_to_bottom(driver, pause=0.5, max_scrolls=30):
    last_height = driver.execute_script("return document.body.scrollHeight")
    for _ in range(max_scrolls):
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(pause)
        new_height = driver.execute_script("return document.body.scrollHeight")
        if new_height == last_height:
            break
        last_height = new_height

def click_buttons(driver, keywords=("load", "more", "next", "accept"), max_clicks=20):
    clicked = 0
    buttons = driver.find_elements(By.TAG_NAME, "button")
    for btn in buttons:
        if clicked >= max_clicks:
            break
        try:
            text = btn.text.lower()
            if any(k in text for k in keywords):
                btn.click()
                time.sleep(0.3)
                clicked += 1
        except WebDriverException:
            continue

def fetch_iframes(driver):
    html = driver.page_source
    iframes = driver.find_elements(By.TAG_NAME, "iframe")
    for iframe in iframes:
        try:
            driver.switch_to.frame(iframe)
            html += driver.page_source
            driver.switch_to.default_content()
        except WebDriverException:
            continue
    return html

try:
    driver.get(url)
    WebDriverWait(driver, 10).until(lambda d: d.execute_script('return document.readyState') == 'complete')

    scroll_to_bottom(driver)
    click_buttons(driver)
    html = fetch_iframes(driver)

    # Truncate safely to 20000 characters
    print(html[:20000])

except TimeoutException:
    print(f"[FETCH TIMEOUT]: {url}", file=sys.stderr)
except Exception as e:
    print(f"[FETCH ERROR]: {e}", file=sys.stderr)
finally:
    driver.quit()