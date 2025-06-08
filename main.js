// 導入 Three.js 核心
import * as THREE from 'three';

// 導入需要的附加元件
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js'; // 通常在 shaders/ 目錄下

// 在進行初始化前先將可用性記錄到控制台，幫助偵錯
console.log("Three.js 版本:", THREE.REVISION);
console.log("PointerLockControls 載入成功:", typeof PointerLockControls === 'function');
console.log("EffectComposer 載入成功:", typeof EffectComposer === 'function');
console.log("RenderPass 載入成功:", typeof RenderPass === 'function');
console.log("ShaderPass 載入成功:", typeof ShaderPass === 'function');
console.log("CopyShader 載入成功:", typeof CopyShader === 'object'); // Shader 通常是物件

// --- 常數與設定 ---
const CORRIDOR_WIDTH = 4;
const CORRIDOR_HEIGHT = 3;
const CORRIDOR_LENGTH = 15; // 單個走廊片段長度
const MOVE_SPEED = 5.0;
const PLAYER_HEIGHT = 1.6; // 稍微調整玩家眼睛高度 (單位：公尺)
const FOG_COLOR = 0x111111; // 霧的顏色
const FOG_NEAR = 1;       // 霧開始距離
const FOG_FAR = CORRIDOR_LENGTH * 2.5; // 霧最遠距離 (線性霧)
// const FOG_DENSITY = 0.08; // 指數霧濃度 (如果用 FogExp2)

// --- 全域變數 ---
let scene, camera, renderer, controls;
let composer; // 用於後處理
let glitchPass; // 保存 Glitch Pass 的引用，方便控制
let clock = new THREE.Clock();
let textureLoader = new THREE.TextureLoader();
let moveState = { forward: false, backward: false, left: false, right: false };
let velocity = new THREE.Vector3();
let direction = new THREE.Vector3();

// --- DOM 元素 ---
const blocker = document.getElementById('blocker');
const instructions = document.getElementById('instructions');
const startButton = document.getElementById('startButton');
const touchControlsElement = document.getElementById('touchControls');

// --- Glitch 著色器定義 (保持不變) ---
const GlitchShader = {
    uniforms: {
        "tDiffuse": { value: null }, // 輸入的紋理 (前一個 Pass 的結果)
        "time": { value: 0.0 },      // 時間，用於動畫
        "amount": { value: 0.005 },   // Glitch 強度 (降低初始值)
        "angle": { value: 0.02 },    // 角度偏移
        "seed": { value: 0.02 },     // 隨機種子
        "distortion_x": { value: 0.1 }, // X 軸扭曲
        "distortion_y": { value: 0.1 }, // Y 軸扭曲
        "col_s": { value: 0.05 }      // 顏色偏移強度
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
    fragmentShader: /* glsl */`
        uniform int bypass; // Int to bypass shader
        uniform sampler2D tDiffuse;
        uniform float time;
        uniform float amount;
        uniform float angle;
        uniform float seed;
        uniform float distortion_x;
        uniform float distortion_y;
        uniform float col_s;
        varying vec2 vUv;

        float rand(vec2 n) {
            return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
        }

        void main() {
            vec2 p = vUv;
            float ty = time * 0.1; // Slow down time effect
            float Strength = amount;

            // Noise
            float grain = rand(p + ty) * 0.1; // Grain amount

            // Vertical Jitter
            float vjitter = rand(vec2(ty, 0.0)) * distortion_y * Strength;
            p.y += vjitter;

            // Horizontal Jitter/Color bleed
            float hjitter = rand(vec2(0.0, ty)) * distortion_x * Strength;
            float rb = rand(p + hjitter) * col_s * Strength;
            float gb = rand(p - hjitter) * col_s * Strength;

            vec2 uvR = vec2(p.x + rb, p.y);
            vec2 uvG = vec2(p.x - gb, p.y);
            vec2 uvB = p;

            // Scanline effect
            float scanline = sin(p.y * 600.0 + ty * 10.0) * 0.02 * Strength;
            float intensity = 0.8 + scanline; // Base intensity + scanline variation

            vec4 color = vec4(
                texture2D(tDiffuse, uvR).r * intensity,
                texture2D(tDiffuse, uvG).g * intensity,
                texture2D(tDiffuse, uvB).b * intensity,
                1.0);

            // Apply noise grain
            color.rgb += grain;

            // Occasional strong glitches (block displacement)
             if (rand(vec2(floor(ty * 5.0), 0.0)) > 0.95) { // Less frequent strong glitches
                 float block_thresh = 0.1;
                 float block_size = rand(vec2(ty * 10.0, 0.0)) * 0.1 + 0.01;
                 if (rand(p) > block_thresh) {
                     vec2 block_uv = floor(p / block_size) * block_size;
                     block_uv += rand(block_uv) * block_size * 0.5 - block_size * 0.25; // Random offset within block
                      if (length(block_uv - p) < block_size * 0.9) { // Avoid edges
                        color = texture2D(tDiffuse, block_uv);
                      }
                 }
             }

            gl_FragColor = color;
        }`
};


// --- 初始化函式 ---
function init() {
    try {
        // 場景
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050505); // 更深的背景色
        scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR); // 啟用線性霧
        // scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY); // 或者使用指數霧

        // 相機
        camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000); // 稍微減小視野
        camera.position.set(0, PLAYER_HEIGHT, 0); // 從原點開始

        // 渲染器
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        // renderer.shadowMap.enabled = true; // 如果需要陰影，取消註解
        // renderer.shadowMap.type = THREE.PCFSoftShadowMap; // 柔和陰影
        document.body.appendChild(renderer.domElement);

        // --- 光照設定 (增強) ---
        // 環境光 (稍微提高)
        const ambientLight = new THREE.AmbientLight(0x404040, 1.5); // 提高強度
        scene.add(ambientLight);

        // 半球光 (提供更自然的天空/地面光)
        const hemisphereLight = new THREE.HemisphereLight(0x606070, 0x202020, 1.5); // 天空色, 地面色, 強度
        scene.add(hemisphereLight);

        // --- 建立初始的走廊 (包含燈具) ---
        const materials = createMaterials(); // 確保材質已建立
        const segmentPositions = [
             new THREE.Vector3(0, 0, -CORRIDOR_LENGTH / 2),
             new THREE.Vector3(0, 0, -CORRIDOR_LENGTH * 1.5)
        ];

        segmentPositions.forEach(pos => {
            const segment = createCorridorSegment(pos, materials);
            scene.add(segment);

            // 在每個走廊片段中間添加一個燈具和光源
            const lightFixture = createLightFixture(new THREE.Vector3(pos.x, CORRIDOR_HEIGHT - 0.2, pos.z));
            scene.add(lightFixture);
        });


        // --- 控制器 (PointerLockControls) ---
        controls = new PointerLockControls(camera, renderer.domElement);
        // 將相機物件加入場景 (注意：不是 controls 本身，而是 controls.getObject())
        // camera is already added implicitly by being the camera used for rendering
        // Adding controls.getObject() might be redundant if the camera is the main object.
        // Let's rely on the camera being part of the scene implicitly.

        startButton.addEventListener('click', () => controls.lock());
        controls.addEventListener('lock', onPointerLock);
        controls.addEventListener('unlock', onPointerUnlock);

        // --- 後處理設定 (啟用 Glitch) ---
        setupPostProcessing();

        // --- 事件監聽 ---
        window.addEventListener('resize', onWindowResize);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
        setupTouchControls();

        // --- 開始動畫循環 ---
        animate();

        console.log("初始化完成");
    } catch (error) {
        console.error("初始化過程中發生嚴重錯誤:", error);
        showErrorMessage(error); // 顯示錯誤給使用者
    }
}

// --- 建立燈具模型與光源 ---
function createLightFixture(position) {
    const fixtureGroup = new THREE.Group();
    fixtureGroup.position.copy(position);

    // 簡單的燈具外殼 (例如一個扁平圓柱)
    const fixtureGeo = new THREE.CylinderGeometry(0.3, 0.4, 0.08, 16); // 半徑上/下, 高度, 分段數
    const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0.4 });
    const fixtureMesh = new THREE.Mesh(fixtureGeo, fixtureMat);
    fixtureGroup.add(fixtureMesh);

    // 發光部分 (稍微小一點的平面或自發光材質)
    const emissiveGeo = new THREE.CircleGeometry(0.25, 16);
    const emissiveMat = new THREE.MeshBasicMaterial({ color: 0xffffee, side: THREE.DoubleSide }); // 基本材質，不受光照影響
    const emissiveMesh = new THREE.Mesh(emissiveGeo, emissiveMat);
    emissiveMesh.rotation.x = Math.PI / 2; // 旋轉使其朝下
    emissiveMesh.position.y = -0.05; // 稍微向下偏移
    fixtureGroup.add(emissiveMesh);


    // 點光源 (放在燈具下方一點)
    const pointLight = new THREE.PointLight(0xffffee, 2.8, CORRIDOR_LENGTH * 1.5); // 提高強度和範圍
    pointLight.position.y = -0.1; // 相對於燈具的位置
    // pointLight.castShadow = true; // 如果需要陰影
    // pointLight.shadow.mapSize.width = 512; // 陰影貼圖大小
    // pointLight.shadow.mapSize.height = 512;
    // pointLight.shadow.camera.near = 0.1;
    // pointLight.shadow.camera.far = CORRIDOR_LENGTH;

    fixtureGroup.add(pointLight);

    return fixtureGroup;
}


// --- 設定後處理 ---
function setupPostProcessing() {
     try {
        composer = new EffectComposer(renderer);

        // 1. Render Pass: 渲染原始場景
        const renderPass = new RenderPass(scene, camera);
        composer.addPass(renderPass);

        // 2. Glitch Pass: 添加 Glitch 效果
        glitchPass = new ShaderPass(GlitchShader);
        composer.addPass(glitchPass);
        console.log("Glitch 效果已加入後處理鏈");

        // 3. Copy Pass: 將最終結果輸出到螢幕
        // **非常重要**: 只有最後一個要輸出到螢幕的 Pass 需要設定 renderToScreen = true
        const copyPass = new ShaderPass(CopyShader);
        copyPass.renderToScreen = true; // <--- 設定這個
        composer.addPass(copyPass);

        console.log("後處理設定成功 (包含 Glitch)");

    } catch (error) {
        console.warn("後處理設定失敗，將使用標準渲染:", error);
        composer = null; // 出錯則禁用後處理
        glitchPass = null;
    }
}

// --- 材質建立函式 ---
function createMaterials() {
    let wallTexture, floorTexture, ceilingTexture;

    const loadTexture = (path, name) => {
        try {
            return textureLoader.load(path,
                () => console.log(`${name} 貼圖載入成功`),
                undefined,
                (error) => { console.warn(`${name} 貼圖載入失敗: ${error.message || error}`); throw error; } // 拋出錯誤以便捕捉
            );
        } catch (error) {
             console.warn(`${name} 貼圖載入異常`, error);
             return null; // 返回 null 表示失敗
        }
    };

    wallTexture = loadTexture('./textures/wall.jpg', '牆壁');
    floorTexture = loadTexture('./textures/floor.jpg', '地板');
    ceilingTexture = loadTexture('./textures/ceiling.jpg', '天花板');

    // 設定貼圖參數
    [wallTexture, floorTexture, ceilingTexture].forEach(tex => {
        if (tex) {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            // 可以嘗試不同的過濾方式改善鋸齒或模糊
            // tex.magFilter = THREE.LinearFilter;
            // tex.minFilter = THREE.LinearMipmapLinearFilter;
        }
    });

    // 設定貼圖重複次數 (根據視覺效果調整)
    const wallRepeatX = CORRIDOR_LENGTH / 4; // 調整重複感
    const wallRepeatY = CORRIDOR_HEIGHT / 2;
    const floorRepeatX = CORRIDOR_WIDTH / 2;
    const floorRepeatY = CORRIDOR_LENGTH / 4;
    const ceilingRepeatX = CORRIDOR_WIDTH / 2;
    const ceilingRepeatY = CORRIDOR_LENGTH / 4;

    if (wallTexture) wallTexture.repeat.set(wallRepeatX, wallRepeatY);
    if (floorTexture) floorTexture.repeat.set(floorRepeatX, floorRepeatY);
    if (ceilingTexture) ceilingTexture.repeat.set(ceilingRepeatX, ceilingRepeatY);

    // 創建材質
    const wallMaterial = new THREE.MeshStandardMaterial({
        map: wallTexture,
        color: wallTexture ? 0xffffff : 0x888888, // 無貼圖時顯示灰色
        side: THREE.DoubleSide,
        roughness: 0.85, // 增加粗糙度，減少反光
        metalness: 0.1
    });
    const floorMaterial = new THREE.MeshStandardMaterial({
        map: floorTexture,
        color: floorTexture ? 0xffffff : 0x666666,
        roughness: 0.9,
        metalness: 0.1
    });
    const ceilingMaterial = new THREE.MeshStandardMaterial({
        map: ceilingTexture,
        color: ceilingTexture ? 0xffffff : 0x777777,
        roughness: 0.9,
        metalness: 0.1
    });
    // 踢腳板材質
    const skirtingMaterial = new THREE.MeshStandardMaterial({
        color: 0x282828, // 深灰色
        roughness: 0.8,
        metalness: 0.1
    });


    return { wall: wallMaterial, floor: floorMaterial, ceiling: ceilingMaterial, skirting: skirtingMaterial };
}

// --- 走廊片段建立函式 (加入踢腳板) ---
function createCorridorSegment(position, materials) {
    const group = new THREE.Group();
    group.position.copy(position);

    const skirtingHeight = 0.15; // 踢腳板高度
    const skirtingDepth = 0.05; // 踢腳板厚度

    // 地板
    const floorGeo = new THREE.PlaneGeometry(CORRIDOR_WIDTH, CORRIDOR_LENGTH);
    const floor = new THREE.Mesh(floorGeo, materials.floor);
    floor.rotation.x = -Math.PI / 2;
    // floor.receiveShadow = true; // 如果啟用陰影
    group.add(floor);

    // 天花板
    const ceilingGeo = new THREE.PlaneGeometry(CORRIDOR_WIDTH, CORRIDOR_LENGTH);
    const ceiling = new THREE.Mesh(ceilingGeo, materials.ceiling);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = CORRIDOR_HEIGHT;
    group.add(ceiling);

    // 左牆
    const wallLeftGeo = new THREE.PlaneGeometry(CORRIDOR_LENGTH, CORRIDOR_HEIGHT);
    const wallLeft = new THREE.Mesh(wallLeftGeo, materials.wall);
    wallLeft.rotation.y = Math.PI / 2;
    wallLeft.position.set(-CORRIDOR_WIDTH / 2, CORRIDOR_HEIGHT / 2, 0);
    // wallLeft.castShadow = true; // 如果啟用陰影
    // wallLeft.receiveShadow = true;
    group.add(wallLeft);

    // 右牆
    const wallRightGeo = new THREE.PlaneGeometry(CORRIDOR_LENGTH, CORRIDOR_HEIGHT);
    const wallRight = new THREE.Mesh(wallRightGeo, materials.wall);
    wallRight.rotation.y = -Math.PI / 2;
    wallRight.position.set(CORRIDOR_WIDTH / 2, CORRIDOR_HEIGHT / 2, 0);
    // wallRight.castShadow = true;
    // wallRight.receiveShadow = true;
    group.add(wallRight);

    // --- 加入踢腳板 ---
    // 左踢腳板
    const skirtingLeftGeo = new THREE.BoxGeometry(CORRIDOR_LENGTH, skirtingHeight, skirtingDepth);
    const skirtingLeft = new THREE.Mesh(skirtingLeftGeo, materials.skirting);
    skirtingLeft.position.set(-CORRIDOR_WIDTH / 2 + skirtingDepth / 2, skirtingHeight / 2, 0); // 稍微向內移
    skirtingLeft.rotation.y = Math.PI / 2; // 旋轉使其沿牆壁方向
    group.add(skirtingLeft);

    // 右踢腳板
    const skirtingRightGeo = new THREE.BoxGeometry(CORRIDOR_LENGTH, skirtingHeight, skirtingDepth);
    const skirtingRight = new THREE.Mesh(skirtingRightGeo, materials.skirting);
    skirtingRight.position.set(CORRIDOR_WIDTH / 2 - skirtingDepth / 2, skirtingHeight / 2, 0); // 稍微向內移
    skirtingRight.rotation.y = -Math.PI / 2; // 旋轉使其沿牆壁方向
    group.add(skirtingRight);


    return group;
}


// --- 事件處理函式 (大部分保持不變) ---
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (composer) composer.setSize(window.innerWidth, window.innerHeight); // 同步更新 composer 大小
}

function onPointerLock() { /* ...保持不變... */
    instructions.style.display = 'none';
    blocker.style.display = 'none';
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        touchControlsElement.style.display = 'block';
    }
}

function onPointerUnlock() { /* ...保持不變... */
    blocker.style.display = 'flex';
    instructions.style.display = '';
    touchControlsElement.style.display = 'none';
    moveState = { forward: false, backward: false, left: false, right: false };
}

function onKeyDown(event) { /* ...保持不變... */
    switch (event.code) {
        case 'KeyW': moveState.forward = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyS': moveState.backward = true; break;
        case 'KeyD': moveState.right = true; break;
    }
}

function onKeyUp(event) { /* ...保持不變... */
     switch (event.code) {
        case 'KeyW': moveState.forward = false; break;
        case 'KeyA': moveState.left = false; break;
        case 'KeyS': moveState.backward = false; break;
        case 'KeyD': moveState.right = false; break;
    }
}

function setupTouchControls() { /* ...保持不變... */
    const buttons = { /*...*/ };
    if (!buttons.w || !buttons.a || !buttons.s || !buttons.d) { /*...*/ return; }
    buttons.w.addEventListener('touchstart', (e) => { e.preventDefault(); moveState.forward = true; }, { passive: false });
    buttons.w.addEventListener('touchend', (e) => { e.preventDefault(); moveState.forward = false; }, { passive: false });
    // ... 其他按鈕事件監聽保持不變 ...
     buttons.a.addEventListener('touchstart', (e) => { e.preventDefault(); moveState.left = true; }, { passive: false });
     buttons.a.addEventListener('touchend', (e) => { e.preventDefault(); moveState.left = false; }, { passive: false });
     buttons.s.addEventListener('touchstart', (e) => { e.preventDefault(); moveState.backward = true; }, { passive: false });
     buttons.s.addEventListener('touchend', (e) => { e.preventDefault(); moveState.backward = false; }, { passive: false });
     buttons.d.addEventListener('touchstart', (e) => { e.preventDefault(); moveState.right = true; }, { passive: false });
     buttons.d.addEventListener('touchend', (e) => { e.preventDefault(); moveState.right = false; }, { passive: false });
}


// --- 動畫循環 (更新 Glitch 參數) ---
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    const elapsedTime = clock.getElapsedTime(); // 獲取總運行時間

    if (controls && controls.isLocked) {
        // --- 移動計算 (保持不變) ---
        velocity.x -= velocity.x * 10.0 * delta;
        velocity.z -= velocity.z * 10.0 * delta;
        direction.z = Number(moveState.forward) - Number(moveState.backward);
        direction.x = Number(moveState.right) - Number(moveState.left);
        direction.normalize();
        if (moveState.forward || moveState.backward) velocity.z -= direction.z * MOVE_SPEED * delta * 10;
        if (moveState.left || moveState.right) velocity.x -= direction.x * MOVE_SPEED * delta * 10;
        controls.moveRight(-velocity.x * delta);
        controls.moveForward(-velocity.z * delta);

        // --- 邊界碰撞 (保持不變) ---
        const minZ = -CORRIDOR_LENGTH * 2 + 1;
        const maxZ = CORRIDOR_LENGTH / 2 - 1;
        const minX = -CORRIDOR_WIDTH / 2 + 0.5;
        const maxX = CORRIDOR_WIDTH / 2 + 0.5;
        if (controls.getObject()) {
            controls.getObject().position.x = Math.max(minX, Math.min(maxX, controls.getObject().position.x));
            controls.getObject().position.z = Math.max(minZ, Math.min(maxZ, controls.getObject().position.z));
        }
    }

    // --- 更新 Glitch 效果時間 ---
    if (glitchPass) {
        glitchPass.uniforms['time'].value = elapsedTime;
        // 可以根據需要動態調整 Glitch 強度，例如：
        // glitchPass.uniforms['amount'].value = Math.max(0.001, Math.abs(Math.sin(elapsedTime * 0.5)) * 0.01);
    }

    // --- 渲染 ---
    if (composer) {
        composer.render(delta); // 使用 EffectComposer 進行渲染
    } else {
        renderer.render(scene, camera); // 如果 Composer 設定失敗，則直接渲染
    }
}

// --- 顯示錯誤訊息到 UI ---
function showErrorMessage(error) {
    if (blocker && instructions) {
        blocker.style.display = 'flex'; // 確保 blocker 可見
        instructions.innerHTML = `<h2>發生錯誤</h2><p>無法啟動實驗。請檢查瀏覽器控制台獲取詳細資訊。</p><p style="color:red;">${error.message || error}</p>`;
    }
}

// --- 程式進入點 (延遲初始化) ---
try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // DOM 已就緒，直接初始化
        init();
    }
} catch (error) {
    // 捕捉同步的初始化錯誤 (雖然大部分會在 init 內部捕捉)
    console.error("程式進入點發生錯誤:", error);
    // 嘗試顯示錯誤，但此時 DOM 可能尚未完全準備好
    showErrorMessage(error);
}