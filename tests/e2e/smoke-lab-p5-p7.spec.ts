import { ciSmokeLabScenarios } from "./smoke-lab.catalog";
import { defineSmokeLabSuite } from "./smoke-lab.shared";

defineSmokeLabSuite("P5-P7", ciSmokeLabScenarios.slice(4));
